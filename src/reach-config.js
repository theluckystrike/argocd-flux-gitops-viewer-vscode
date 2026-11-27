'use strict';
module.exports = {
  prefix: 'zovoGitopsview',
  triesKey: 'zovoGitopsview.proTrial',
  slot: '#protools',
  tools: [
    { id: 'auditGitopsManifest', title: 'Audit ArgoCD & Flux sync & security', command: 'zovoGitopsview.auditGitopsManifest' },
    { id: 'diffGitopsManifests', title: 'Compare two GitOps manifests', command: 'zovoGitopsview.diffGitopsManifests' },
    { id: 'exportGitopsInventory', title: 'Export GitOps app & source inventory', command: 'zovoGitopsview.exportGitopsInventory' },
  ],
};
