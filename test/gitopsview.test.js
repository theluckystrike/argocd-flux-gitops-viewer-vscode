'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  parseGitopsManifest,
  detectEngine,
  buildAuditMarkdown,
  buildDiffMarkdown,
  buildInventoryCsv,
  buildInventoryMarkdown,
} = require('../src/gitopsview');
const { GitopsViewModel } = require('../src/view');
const { editorHtml } = require('../src/html');

const samplesDir = path.join(__dirname, '..', 'samples');

test('detects ArgoCD and Flux v2 engines', () => {
  assert.equal(detectEngine('argoproj.io/v1alpha1', 'Application'), 'ArgoCD');
  assert.equal(detectEngine('source.toolkit.fluxcd.io/v1', 'GitRepository'), 'Flux v2');
  assert.equal(detectEngine('helm.toolkit.fluxcd.io/v2', 'HelmRelease'), 'Flux v2');
});

test('parses sample ArgoCD application.yaml and flags HEAD, prune without selfHeal, and AppProject wildcards', () => {
  const buf = fs.readFileSync(path.join(samplesDir, 'application.yaml'));
  const parsed = parseGitopsManifest(buf, 'application.yaml');
  assert.equal(parsed.meta.format, 'ArgoCD');
  assert.equal(parsed.rows.length, 2);
  assert.ok(parsed.findings.some((f) => f.rule === 'floating-target-revision'));
  assert.ok(parsed.findings.some((f) => f.rule === 'prune-without-selfheal'));
  assert.ok(parsed.findings.some((f) => f.rule === 'wildcard-source-repos'));
  assert.ok(parsed.findings.some((f) => f.rule === 'wildcard-cluster-resources'));
});

test('parses sample Flux gotk-sync.yaml and flags HTTP source, floating main, suspend and default namespace', () => {
  const buf = fs.readFileSync(path.join(samplesDir, 'gotk-sync.yaml'));
  const parsed = parseGitopsManifest(buf, 'gotk-sync.yaml');
  assert.equal(parsed.meta.format, 'Flux v2');
  assert.equal(parsed.rows.length, 2);
  assert.ok(parsed.findings.some((f) => f.rule === 'insecure-http-source'));
  assert.ok(parsed.findings.some((f) => f.rule === 'floating-target-revision'));
  assert.ok(parsed.findings.some((f) => f.rule === 'reconcile-suspended'));
  assert.ok(parsed.findings.some((f) => f.rule === 'default-namespace-target'));
});

test('parses clean Flux helmrelease.yaml with zero findings', () => {
  const buf = fs.readFileSync(path.join(samplesDir, 'helmrelease.yaml'));
  const parsed = parseGitopsManifest(buf, 'helmrelease.yaml');
  assert.equal(parsed.meta.format, 'Flux v2');
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.findings.length, 0);
});

test('GitopsViewModel filters and paginates resources and builds audit, diff and inventory exports', () => {
  const argo = parseGitopsManifest(fs.readFileSync(path.join(samplesDir, 'application.yaml')), 'application.yaml');
  const flux = parseGitopsManifest(fs.readFileSync(path.join(samplesDir, 'gotk-sync.yaml')), 'gotk-sync.yaml');
  const vm = new GitopsViewModel(argo, 'application.yaml', 512);
  assert.equal(vm.summary().name, 'application.yaml');
  assert.ok(vm.setFilter({ kind: 'findings' }) > 0);
  assert.ok(vm.setFilter({ text: 'checkout' }) === 1);
  assert.ok(vm.detail(1));

  const audit = buildAuditMarkdown([{ fileName: 'application.yaml', parsed: argo }, { fileName: 'gotk-sync.yaml', parsed: flux }]);
  assert.match(audit, /ArgoCD & Flux GitOps Sync & Security Audit/);
  const diff = buildDiffMarkdown('application.yaml', argo, 'gotk-sync.yaml', flux);
  assert.match(diff, /GitOps Manifest Diff/);
  const csv = buildInventoryCsv(argo);
  assert.match(csv, /^line,engine,kind,name,source,destination,sync,risk/m);
  const md = buildInventoryMarkdown(argo, 'application.yaml');
  assert.match(md, /GitOps Inventory/);
});

test('editorHtml enforces strict CSP with nonce', () => {
  const html = editorHtml({ cspSource: 'vscode-webview://x', script: 'viewer.js', styleUri: 'viewer.css', title: 'application.yaml', nonce: 'xyz789' });
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'nonce-xyz789'/);
});
