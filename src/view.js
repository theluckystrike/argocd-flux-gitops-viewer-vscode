'use strict';
// View model for ArgoCD & Flux GitOps Viewer: pagination and filtering by engine/kind, findings and text.

class GitopsViewModel {
  constructor(parsed, name, fileSize) {
    this.parsed = parsed;
    this.name = name;
    this.fileSize = fileSize;
    this.filter = { text: '', kind: '' };
    this.filtered = parsed.rows.slice();
  }

  summary() {
    const p = this.parsed;
    const s = p.stats;
    return {
      name: this.name,
      fileSize: this.fileSize,
      meta: p.meta,
      totalLines: p.totalLines,
      rowCount: s.rowCount,
      sourceCount: s.sourceCount,
      syncCount: s.syncCount,
      destinationCount: s.destinationCount,
      findingErrors: s.findingErrors,
      findingWarnings: s.findingWarnings,
      sources: p.sources,
      syncs: p.syncs,
      destinations: p.destinations,
      findings: p.findings,
    };
  }

  totalCount() {
    return this.parsed.rows.length;
  }

  count() {
    return this.filtered.length;
  }

  setFilter(f) {
    const text = f && typeof f.text === 'string' ? f.text.trim().toLowerCase() : '';
    const kind = f && typeof f.kind === 'string' ? f.kind.trim() : '';
    this.filter = { text, kind };
    this.filtered = this.parsed.rows.filter((r) => {
      if (kind === 'findings' && !r.errorCount && !r.warningCount) return false;
      if (kind && kind !== 'findings' && r.engine !== kind && r.kind !== kind) return false;
      if (text) {
        const hay = `${r.name} ${r.kind} ${r.engine} ${r.source} ${r.destination} ${r.syncSummary} ${r.badge} ${r.raw}`.toLowerCase();
        if (!hay.includes(text)) return false;
      }
      return true;
    });
    return this.filtered.length;
  }

  rows(from, limit) {
    const start = Math.max(0, Number(from) || 0);
    const n = Math.max(1, Math.min(500, Number(limit) || 100));
    return this.filtered.slice(start, start + n).map((r) => ({
      index: r.index,
      line: r.line,
      name: r.name,
      kind: r.kind,
      engine: r.engine,
      source: r.source,
      destination: r.destination,
      syncSummary: r.syncSummary,
      badge: r.badge,
      risk: r.risk,
      errorCount: r.errorCount,
      warningCount: r.warningCount,
    }));
  }

  detail(index) {
    const r = this.parsed.rows.find((x) => x.index === index) || this.parsed.rows[0] || null;
    if (!r) return null;
    return {
      index: r.index,
      line: r.line,
      name: r.name,
      kind: r.kind,
      engine: r.engine,
      badge: r.badge,
      risk: r.risk,
      raw: r.raw,
      findings: r.findings,
      attrs: r.attrs,
    };
  }
}

module.exports = { GitopsViewModel };
