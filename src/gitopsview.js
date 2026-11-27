'use strict';
// Offline zero-dependency parser and static auditor for ArgoCD (Application, ApplicationSet, AppProject)
// and Flux v2 (GitRepository, HelmRepository, OCIRepository, Kustomization, HelmRelease) YAML manifests.

function stripComment(line) {
  let inS = false;
  let inD = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !inD) inS = !inS;
    else if (ch === '"' && !inS && line[i - 1] !== '\\') inD = !inD;
    else if (ch === '#' && !inS && !inD && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function unquote(v) {
  const s = String(v || '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function splitYamlDocs(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const docs = [];
  let cur = [];
  let startLine = 1;
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    if (/^\s*---\s*$/.test(l)) {
      if (cur.some((x) => stripComment(x).trim())) {
        docs.push({ startLine, lines: cur });
      }
      cur = [];
      startLine = i + 2;
    } else {
      cur.push(l);
    }
  }
  if (cur.some((x) => stripComment(x).trim())) {
    docs.push({ startLine, lines: cur });
  }
  return { totalLines: lines.length, docs };
}

function parseDocKv(docLines, startLine) {
  const stack = [];
  const kvs = [];
  const listValues = new Map();

  for (let i = 0; i < docLines.length; i += 1) {
    const lineNo = startLine + i;
    const cleaned = stripComment(docLines[i]).replace(/\s+$/, '');
    if (!cleaned.trim() || cleaned.trim() === '...') continue;
    const indent = cleaned.match(/^(\s*)/)[1].length;
    const trimmed = cleaned.trim();

    if (trimmed.startsWith('- ')) {
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      const parent = stack.map((s) => s.key).join('.');
      const rest = trimmed.slice(2).trim();
      const kv = rest.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
      if (kv) {
        const val = unquote(kv[2]);
        kvs.push({ path: parent ? `${parent}[].${kv[1]}` : kv[1], key: kv[1], value: val, line: lineNo });
      } else {
        const val = unquote(rest);
        if (!listValues.has(parent)) listValues.set(parent, []);
        listValues.get(parent).push({ value: val, line: lineNo });
      }
      continue;
    }

    const kv = trimmed.match(/^([A-Za-z0-9_./-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const val = unquote(kv[2]);
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const fullPath = stack.length ? `${stack.map((s) => s.key).join('.')}.${key}` : key;
    if (val === '' || val === '|' || val === '>') {
      stack.push({ key, indent });
    } else {
      kvs.push({ path: fullPath, key, value: val, line: lineNo });
    }
  }

  const get = (...paths) => {
    for (const p of paths) {
      const hit = kvs.find((x) => x.path === p);
      if (hit) return hit;
    }
    return null;
  };
  const getBySuffix = (suffix) => kvs.find((x) => x.path === suffix || x.path.endsWith(`.${suffix}`)) || null;
  const listOf = (p) => listValues.get(p) || [];

  return { kvs, listValues, get, getBySuffix, listOf };
}

function detectEngine(apiVersion, kind) {
  const api = String(apiVersion || '').toLowerCase();
  const k = String(kind || '');
  if (api.includes('argoproj.io') || /^(Application|ApplicationSet|AppProject)$/.test(k)) return 'ArgoCD';
  if (api.includes('fluxcd.io') || /^(GitRepository|HelmRepository|OCIRepository|HelmRelease|Kustomization|Bucket)$/.test(k)) return 'Flux v2';
  return 'Kubernetes';
}

function parseGitopsManifest(bufOrStr, fileName = 'application.yaml') {
  const text = Buffer.isBuffer(bufOrStr) ? bufOrStr.toString('utf8') : String(bufOrStr || '');
  const { totalLines, docs } = splitYamlDocs(text);

  const rows = [];
  const sources = [];
  const syncs = [];
  const destinations = [];
  const findings = [];
  const engines = new Set();
  let rowIndex = 0;

  const addFinding = (severity, category, rule, line, target, message) => {
    const f = { severity, category, rule, line, target, message };
    findings.push(f);
    return f;
  };

  for (const d of docs) {
    const p = parseDocKv(d.lines, d.startLine);
    const apiVersion = (p.get('apiVersion') || {}).value || '-';
    const kind = (p.get('kind') || {}).value || 'Document';
    const name = (p.get('metadata.name') || {}).value || `${fileName}#${rowIndex + 1}`;
    const ns = (p.get('metadata.namespace') || {}).value || '-';
    const engine = detectEngine(apiVersion, kind);
    engines.add(engine);
    const raw = d.lines.join('\n').trim();
    const rf = [];

    // Source extraction
    const repoHit = p.get('spec.source.repoURL', 'spec.template.spec.source.repoURL', 'spec.url');
    const revHit = p.get('spec.source.targetRevision', 'spec.template.spec.source.targetRevision', 'spec.ref.branch', 'spec.ref.tag', 'spec.ref.semver', 'spec.chart.spec.version');
    const pathHit = p.get('spec.source.path', 'spec.template.spec.source.path', 'spec.path', 'spec.source.chart', 'spec.chart.spec.chart');
    const sourceRefName = (p.get('spec.sourceRef.name', 'spec.chart.spec.sourceRef.name') || {}).value || '';
    const sourceRefKind = (p.get('spec.sourceRef.kind', 'spec.chart.spec.sourceRef.kind') || {}).value || '';

    const repoUrl = repoHit ? repoHit.value : (sourceRefName ? `${sourceRefKind || 'Source'}/${sourceRefName}` : '-');
    const revision = revHit ? revHit.value : '-';
    const sourcePath = pathHit ? pathHit.value : '-';

    if (repoHit && /^http:\/\//i.test(repoHit.value)) {
      rf.push(addFinding('error', 'Security', 'insecure-http-source', repoHit.line, name, `${kind} "${name}" pulls from plain HTTP source "${repoHit.value}". Use https:// or ssh://.`));
    }
    if (revHit && /^(HEAD|main|master|latest|\*)$/i.test(revHit.value)) {
      rf.push(addFinding('warning', 'Drift', 'floating-target-revision', revHit.line, name, `${kind} "${name}" tracks floating revision "${revHit.value}". Pin a release tag, semver or commit SHA for production.`));
    }

    if (repoUrl !== '-' || sourcePath !== '-') {
      sources.push({
        line: (repoHit || pathHit || { line: d.startLine }).line,
        name,
        engine,
        url: repoUrl,
        revision,
        path: sourcePath,
        risk: rf.length ? 'review' : 'ok',
      });
    }

    // Sync / Reconcile extraction
    const pruneHit = p.get('spec.syncPolicy.automated.prune', 'spec.template.spec.syncPolicy.automated.prune', 'spec.prune');
    const selfHealHit = p.get('spec.syncPolicy.automated.selfHeal', 'spec.template.spec.syncPolicy.automated.selfHeal');
    const intervalHit = p.get('spec.interval');
    const retryHit = p.get('spec.retryInterval', 'spec.syncPolicy.retry.limit');
    const suspendHit = p.get('spec.suspend');
    const syncOpts = p.listOf('spec.syncPolicy.syncOptions').concat(p.listOf('spec.template.spec.syncPolicy.syncOptions')).map((x) => x.value);

    const prune = pruneHit ? pruneHit.value : '-';
    const selfHeal = selfHealHit ? selfHealHit.value : '-';
    const interval = intervalHit ? intervalHit.value : '-';
    const suspend = suspendHit ? suspendHit.value : 'false';

    if (suspend === 'true') {
      rf.push(addFinding('warning', 'Reconcile', 'reconcile-suspended', suspendHit.line, name, `${kind} "${name}" has spec.suspend: true. Automated GitOps reconciliation is paused.`));
    }
    if (engine === 'ArgoCD' && prune === 'true' && selfHeal !== 'true') {
      rf.push(addFinding('warning', 'Sync', 'prune-without-selfheal', pruneHit.line, name, `${kind} "${name}" enables automated prune without selfHeal: true.`));
    }
    if (engine === 'Flux v2' && /^(Kustomization|HelmRelease|GitRepository|HelmRepository|OCIRepository)$/.test(kind) && !intervalHit) {
      rf.push(addFinding('warning', 'Reconcile', 'missing-flux-interval', d.startLine, name, `Flux ${kind} "${name}" does not specify spec.interval.`));
    }
    if (pruneHit || selfHealHit || intervalHit || suspendHit || syncOpts.length) {
      syncs.push({
        line: (pruneHit || intervalHit || suspendHit || { line: d.startLine }).line,
        name,
        engine,
        mode: engine === 'ArgoCD' ? `prune=${prune} selfHeal=${selfHeal}` : `interval=${interval} prune=${prune}`,
        suspend,
        options: syncOpts.join(', ') || (retryHit ? `retry=${retryHit.value}` : '-'),
        risk: suspend === 'true' || (engine === 'ArgoCD' && prune === 'true' && selfHeal !== 'true') ? 'review' : 'ok',
      });
    }

    // Destination & AppProject RBAC extraction
    const destServer = (p.get('spec.destination.server', 'spec.template.spec.destination.server', 'spec.destination.name') || {}).value || (engine === 'Flux v2' ? 'in-cluster' : '-');
    const destNsHit = p.get('spec.destination.namespace', 'spec.template.spec.destination.namespace', 'spec.targetNamespace');
    const destNs = destNsHit ? destNsHit.value : ns;
    const project = (p.get('spec.project', 'spec.template.spec.project') || {}).value || '-';

    if (destNsHit && destNsHit.value === 'default') {
      rf.push(addFinding('warning', 'Destination', 'default-namespace-target', destNsHit.line, name, `${kind} "${name}" deploys into the "default" namespace.`));
    }
    if (kind === 'AppProject') {
      const srcRepos = p.listOf('spec.sourceRepos');
      if (srcRepos.some((x) => x.value === '*')) {
        rf.push(addFinding('error', 'Security', 'wildcard-source-repos', d.startLine, name, `AppProject "${name}" allows wildcard spec.sourceRepos: ["*"]. Restrict to approved Git repositories.`));
      }
      const clusterWhite = p.kvs.filter((x) => x.path.startsWith('spec.clusterResourceWhitelist'));
      if (clusterWhite.some((x) => x.value === '*')) {
        rf.push(addFinding('error', 'Security', 'wildcard-cluster-resources', d.startLine, name, `AppProject "${name}" grants wildcard clusterResourceWhitelist ("*"). Restrict cluster-scoped kinds.`));
      }
    }

    destinations.push({
      line: (destNsHit || { line: d.startLine }).line,
      name,
      engine,
      cluster: destServer,
      namespace: destNs,
      scope: kind === 'AppProject' ? 'AppProject RBAC' : (project !== '-' ? `project=${project}` : kind),
      risk: rf.some((f) => f.category === 'Security' || f.category === 'Destination') ? 'review' : 'ok',
    });

    rowIndex += 1;
    const errorCount = rf.filter((x) => x.severity === 'error').length;
    const warningCount = rf.filter((x) => x.severity === 'warning').length;
    const risk = errorCount > 0 ? `${errorCount} error${errorCount === 1 ? '' : 's'}` : (warningCount > 0 ? `${warningCount} warning${warningCount === 1 ? '' : 's'}` : 'ok');
    const syncSummary = suspend === 'true' ? 'SUSPENDED' : (engine === 'ArgoCD' ? `prune=${prune}, selfHeal=${selfHeal}` : `interval=${interval}, prune=${prune}`);

    rows.push({
      index: rowIndex,
      line: d.startLine,
      name,
      kind,
      engine,
      source: revision !== '-' ? `${repoUrl} @ ${revision}` : repoUrl,
      destination: destNs !== '-' ? `${destServer} / ${destNs}` : destServer,
      syncSummary,
      badge: kind,
      risk,
      errorCount,
      warningCount,
      raw,
      findings: rf,
      attrs: [
        { key: 'Engine', value: engine },
        { key: 'API Version', value: apiVersion },
        { key: 'Kind', value: kind },
        { key: 'Metadata Name', value: name },
        { key: 'Metadata Namespace', value: ns },
        { key: 'Source', value: repoUrl },
        { key: 'Revision / Ref', value: revision },
        { key: 'Path / Chart', value: sourcePath },
        { key: 'Destination', value: `${destServer} (${destNs})` },
        { key: 'Sync / Reconcile', value: syncSummary },
      ],
    });
  }

  const format = engines.size > 1 ? 'ArgoCD + Flux' : (engines.values().next().value || 'GitOps YAML');
  const findingErrors = findings.filter((f) => f.severity === 'error').length;
  const findingWarnings = findings.filter((f) => f.severity === 'warning').length;

  return {
    meta: { format, docCount: docs.length },
    totalLines,
    rows,
    sources,
    syncs,
    destinations,
    findings,
    stats: {
      rowCount: rows.length,
      sourceCount: sources.length,
      syncCount: syncs.length,
      destinationCount: destinations.length,
      findingErrors,
      findingWarnings,
    },
  };
}

function buildAuditMarkdown(entries) {
  const lines = ['# ArgoCD & Flux GitOps Sync & Security Audit', ''];
  let totalErrors = 0;
  let totalWarnings = 0;
  for (const e of entries) {
    totalErrors += e.parsed.stats.findingErrors;
    totalWarnings += e.parsed.stats.findingWarnings;
  }
  lines.push(`- Files audited: **${entries.length}**`);
  lines.push(`- Total errors: **${totalErrors}**`);
  lines.push(`- Total warnings: **${totalWarnings}**`, '');

  for (const e of entries) {
    const p = e.parsed;
    lines.push(`## ${e.fileName} (${p.meta.format})`, '');
    lines.push(`- Resources: ${p.stats.rowCount} | Sources: ${p.stats.sourceCount} | Sync Policies: ${p.stats.syncCount} | Destinations: ${p.stats.destinationCount}`);
    lines.push(`- Findings: ${p.stats.findingErrors} error(s), ${p.stats.findingWarnings} warning(s)`, '');
    if (p.findings.length) {
      lines.push('| Severity | Category | Rule | Line | Target | Message |');
      lines.push('| --- | --- | --- | ---: | --- | --- |');
      for (const f of p.findings) {
        lines.push(`| ${f.severity.toUpperCase()} | ${f.category} | \`${f.rule}\` | ${f.line} | \`${f.target}\` | ${f.message} |`);
      }
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
}

function buildDiffMarkdown(leftName, left, rightName, right) {
  const lines = [`# GitOps Manifest Diff: ${leftName} vs ${rightName}`, ''];
  const lMap = new Map(left.rows.map((r) => [`${r.kind}/${r.name}`, r]));
  const rMap = new Map(right.rows.map((r) => [`${r.kind}/${r.name}`, r]));
  const added = [];
  const removed = [];
  const changed = [];

  for (const [k, r] of rMap.entries()) {
    if (!lMap.has(k)) added.push(r);
    else {
      const l = lMap.get(k);
      if (l.source !== r.source || l.destination !== r.destination || l.syncSummary !== r.syncSummary) {
        changed.push({ key: k, before: `${l.source} -> ${l.destination} (${l.syncSummary})`, after: `${r.source} -> ${r.destination} (${r.syncSummary})` });
      }
    }
  }
  for (const [k, l] of lMap.entries()) {
    if (!rMap.has(k)) removed.push(l);
  }

  lines.push(`- Baseline: **${leftName}** (${left.meta.format}, ${left.rows.length} resources)`);
  lines.push(`- Compared: **${rightName}** (${right.meta.format}, ${right.rows.length} resources)`);
  lines.push(`- Summary: **${added.length}** added, **${removed.length}** removed, **${changed.length}** changed`, '');

  if (added.length) {
    lines.push('## Added', '');
    for (const r of added) lines.push(`- \`${r.kind}/${r.name}\`: ${r.source} -> ${r.destination}`);
    lines.push('');
  }
  if (removed.length) {
    lines.push('## Removed', '');
    for (const r of removed) lines.push(`- \`${r.kind}/${r.name}\`: ${r.source} -> ${r.destination}`);
    lines.push('');
  }
  if (changed.length) {
    lines.push('## Changed', '');
    lines.push('| Resource | Before | After |');
    lines.push('| --- | --- | --- |');
    for (const c of changed) lines.push(`| \`${c.key}\` | \`${c.before}\` | \`${c.after}\` |`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildInventoryCsv(parsed) {
  const header = ['line', 'engine', 'kind', 'name', 'source', 'destination', 'sync', 'risk'];
  const out = [header.join(',')];
  for (const r of parsed.rows) {
    out.push([r.line, r.engine, r.kind, r.name, r.source, r.destination, r.syncSummary, r.risk].map(csvCell).join(','));
  }
  return `${out.join('\n')}\n`;
}

function buildInventoryMarkdown(parsed, fileName) {
  const lines = [`# GitOps Inventory: ${fileName}`, ''];
  lines.push(`- Engine: **${parsed.meta.format}**`);
  lines.push(`- Resources: **${parsed.stats.rowCount}** | Sources: **${parsed.stats.sourceCount}** | Sync Policies: **${parsed.stats.syncCount}**`, '');
  lines.push('| Line | Engine | Kind | Name | Source | Destination | Sync | Status |');
  lines.push('| ---: | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of parsed.rows) {
    lines.push(`| ${r.line} | ${r.engine} | ${r.kind} | \`${r.name}\` | \`${r.source}\` | \`${r.destination}\` | ${r.syncSummary} | ${r.risk} |`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

module.exports = {
  parseGitopsManifest,
  detectEngine,
  buildAuditMarkdown,
  buildDiffMarkdown,
  buildInventoryCsv,
  buildInventoryMarkdown,
};
