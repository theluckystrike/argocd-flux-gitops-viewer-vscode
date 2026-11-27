'use strict';
// Pro tools for ArgoCD & Flux GitOps Viewer:
//   1. auditGitopsManifest: Offline Markdown ArgoCD and Flux sync and security audit.
//   2. diffGitopsManifests: Compare two ArgoCD or Flux YAML manifests in Markdown.
//   3. exportGitopsInventory: Non-destructive Markdown and CSV GitOps app and source inventory export.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const {
  parseGitopsManifest,
  buildAuditMarkdown,
  buildDiffMarkdown,
  buildInventoryCsv,
  buildInventoryMarkdown,
} = require('./gitopsview');

const MATCH_RE = /^(application(set)?|appproject|gotk-sync|gotk-components|gitrepository|helmrelease)\.ya?ml$|^.+\.(argocd|flux)\.ya?ml$/i;

function uniquePath(targetPath) {
  if (!fs.existsSync(targetPath)) return targetPath;
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);
  for (let i = 1; i < 10000; i += 1) {
    const cand = path.join(dir, `${base}-${i}${ext}`);
    if (!fs.existsSync(cand)) return cand;
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

async function resolveTargetUri(uri, provider, openLabel = 'Select ArgoCD or Flux GitOps YAML file') {
  if (uri && uri.scheme) return uri;
  if (provider && provider.active && provider.active.uri) return provider.active.uri;
  const ed = vscode.window.activeTextEditor;
  if (ed && ed.document && MATCH_RE.test(path.basename(ed.document.uri.fsPath || ed.document.uri.path))) {
    return ed.document.uri;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { 'GitOps YAML': ['yaml', 'yml'] },
    openLabel,
  });
  return picked && picked[0] ? picked[0] : null;
}

function listGitopsManifestsInDir(dirPath, maxDepth = 4) {
  const out = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name === 'build') continue;
      const full = path.join(dir, e.name);
      if (e.isFile() && MATCH_RE.test(e.name)) out.push(full);
      else if (e.isDirectory() && depth < maxDepth) walk(full, depth + 1);
    }
  }
  walk(dirPath, 0);
  return out.sort();
}

function createTools({ provider, pro, reach }) {
  async function auditGitopsManifest(uri, opts = {}) {
    if (!(await pro.allowed('auditGitopsManifest', opts))) return undefined;
    const target = await resolveTargetUri(uri, provider);
    if (!target) return undefined;

    const targetPath = target.fsPath;
    const isDir = target.scheme === 'file' && fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory();
    const files = isDir ? listGitopsManifestsInDir(targetPath) : [targetPath];
    if (!files.length) {
      vscode.window.showInformationMessage('No ArgoCD or Flux GitOps YAML files were found in this folder.');
      return undefined;
    }

    const entries = [];
    for (const f of files) {
      const buf = f === targetPath && target.scheme !== 'file'
        ? Buffer.from(await vscode.workspace.fs.readFile(target))
        : fs.readFileSync(f);
      const label = isDir ? path.relative(targetPath, f) : path.basename(f);
      entries.push({ fileName: label, parsed: parseGitopsManifest(buf, path.basename(f)) });
    }
    const md = buildAuditMarkdown(entries);
    const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: false });
    await pro.produced('auditGitopsManifest');
    if (reach) reach.refresh();
    return { files: files.length, markdown: md };
  }

  async function diffGitopsManifests(uri, opts = {}) {
    if (!(await pro.allowed('diffGitopsManifests', opts))) return undefined;
    const left = await resolveTargetUri(uri, provider, 'Select baseline GitOps manifest');
    if (!left) return undefined;

    let right = opts.compareUri || null;
    if (!right) {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { 'GitOps YAML': ['yaml', 'yml'] },
        openLabel: 'Select second GitOps manifest to compare',
      });
      right = picked && picked[0] ? picked[0] : null;
    }
    if (!right) return undefined;

    const leftBuf = Buffer.from(await vscode.workspace.fs.readFile(left));
    const rightBuf = Buffer.from(await vscode.workspace.fs.readFile(right));
    const leftName = path.basename(left.fsPath || left.path);
    const rightName = path.basename(right.fsPath || right.path);
    const md = buildDiffMarkdown(
      leftName,
      parseGitopsManifest(leftBuf, leftName),
      rightName,
      parseGitopsManifest(rightBuf, rightName),
    );
    const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: false });
    await pro.produced('diffGitopsManifests');
    if (reach) reach.refresh();
    return { markdown: md };
  }

  async function exportGitopsInventory(uri, opts = {}) {
    if (!(await pro.allowed('exportGitopsInventory', opts))) return undefined;
    const target = await resolveTargetUri(uri, provider);
    if (!target) return undefined;

    const targetPath = target.fsPath;
    const bytes = await vscode.workspace.fs.readFile(target);
    const baseName = path.basename(targetPath);
    const parsed = parseGitopsManifest(Buffer.from(bytes), baseName);
    const stemRaw = baseName.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'gitops-manifest';
    const defaultOut = uniquePath(path.join(path.dirname(targetPath), `${stemRaw}.gitops.csv`));
    const saveUri = opts.outPath
      ? vscode.Uri.file(uniquePath(opts.outPath))
      : await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(defaultOut),
        filters: { 'CSV GitOps Inventory': ['csv'] },
        saveLabel: 'Save Markdown and CSV GitOps inventory',
      });
    if (!saveUri) return undefined;

    const csvPath = uniquePath(saveUri.fsPath);
    const dir = path.dirname(csvPath);
    const stem = path.basename(csvPath, '.csv').replace(/\.gitops$/i, '');
    const mdPath = uniquePath(path.join(dir, `${stem}.gitops.md`));

    fs.writeFileSync(csvPath, buildInventoryCsv(parsed), 'utf8');
    fs.writeFileSync(mdPath, buildInventoryMarkdown(parsed, baseName), 'utf8');

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(mdPath));
    await vscode.window.showTextDocument(doc, { preview: false });
    await pro.produced('exportGitopsInventory');
    if (reach) reach.refresh();
    return { files: [csvPath, mdPath], items: parsed.rows.length };
  }

  return { auditGitopsManifest, diffGitopsManifests, exportGitopsInventory };
}

module.exports = { createTools, uniquePath, listGitopsManifestsInDir };
