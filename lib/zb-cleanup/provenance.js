'use strict';

// Provenance block for summary.json. Captures enough context that an
// operator opening the report a month later can reconstruct what code,
// what database, and what schema state produced it.
//
// Pure read of metadata. No DB writes. Git calls are best-effort and
// fall back to null on failure (worktree without .git, CI runner, etc.).

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

function safeExec(cmd) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function getGitInfo() {
  const branch = safeExec('git rev-parse --abbrev-ref HEAD');
  const commit = safeExec('git rev-parse HEAD');
  const dirty = safeExec('git status --porcelain');
  return {
    branch,
    commit,
    is_dirty: dirty == null ? null : dirty.length > 0,
  };
}

function getMigrationState(backendRoot) {
  // List the files in /migrations/ alphabetically; latest filename = latest
  // migration intended to be applied. This is a code-side declaration —
  // confirming it actually ran on the DB is a separate runtime check
  // (see classifier validation in CLI).
  const dir = path.join(backendRoot, 'migrations');
  if (!fs.existsSync(dir)) return { latest_migration_file: null, count: 0 };
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  return {
    latest_migration_file: files[files.length - 1] || null,
    count: files.length,
  };
}

async function getPostgresVersion(supabase) {
  // Supabase RPC exposes select-only via .rpc, but `version()` requires a
  // function definition. Easiest portable path: select from a small system
  // view. pg_settings is read-only and exposes server_version.
  try {
    const { data, error } = await supabase
      .from('pg_settings')
      .select('setting')
      .eq('name', 'server_version')
      .maybeSingle();
    if (error) return { server_version: null, error: error.message };
    return { server_version: data ? data.setting : null };
  } catch (e) {
    return { server_version: null, error: e.message };
  }
}

function parseProjectRef(supabaseUrl) {
  if (!supabaseUrl) return null;
  // https://<ref>.supabase.co
  const m = /^https?:\/\/([a-z0-9-]+)\.supabase\.co/i.exec(supabaseUrl);
  return m ? m[1] : null;
}

async function buildProvenance({
  supabase,
  supabaseUrl,
  backendRoot,
  scriptPath,
  classifierVersion,
}) {
  const [git, pg] = [getGitInfo(), await getPostgresVersion(supabase)];
  return {
    project_ref: parseProjectRef(supabaseUrl),
    supabase_url: supabaseUrl || null,
    git,
    migration_state: getMigrationState(backendRoot),
    postgres: pg,
    generated_by: {
      script_path: scriptPath,
      classifier_version: classifierVersion,
      node_version: process.version,
      platform: process.platform,
    },
  };
}

module.exports = {
  buildProvenance,
  parseProjectRef,
  getGitInfo,
  getMigrationState,
  getPostgresVersion,
};
