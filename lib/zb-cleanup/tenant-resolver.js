'use strict';

// Tenant resolution for the ZB cleanup classifier.
//
// HARD SAFETY RULE:
//   Production execution requires explicit --user-id <int>.
//   Fuzzy lookup (--tenant <alias>) is DISCOVERY ONLY — it lists candidates
//   and returns them; it never auto-selects, never returns "the only match
//   so just use it", never short-circuits the explicit-id requirement.
//
// The CLI enforces the rule. This module only provides the lookup
// primitives. discoverCandidates() returns the evidence list; the caller
// decides what to do with it.

async function discoverCandidates(supabase, alias) {
  if (!alias || typeof alias !== 'string') {
    throw new Error('discoverCandidates: alias string required');
  }
  const fragment = '%' + alias + '%';

  const out = {
    alias,
    by_email: [],
    by_business_name: [],
    by_workspace: [],
    merged_unique_user_ids: [],
  };

  // Email lookup. We accept any email containing the alias (e.g. spotless).
  const { data: byEmail, error: e1 } = await supabase
    .from('users')
    .select('id, email, business_name, created_at')
    .ilike('email', fragment)
    .order('created_at', { ascending: true })
    .limit(50);
  if (e1) throw new Error(`tenant-resolver email lookup: ${e1.message}`);
  out.by_email = byEmail || [];

  // Business name lookup. Same alias.
  const { data: byBusiness, error: e2 } = await supabase
    .from('users')
    .select('id, email, business_name, created_at')
    .ilike('business_name', fragment)
    .order('created_at', { ascending: true })
    .limit(50);
  if (e2) throw new Error(`tenant-resolver business_name lookup: ${e2.message}`);
  out.by_business_name = byBusiness || [];

  // Workspace lookup → cross-reference owner_user_id back to users.
  // sf_workspaces.owner_user_id is the FK; verify it exists (it was added
  // in migration 003 per CLAUDE.md, but defensive against missing column).
  let byWorkspace = [];
  try {
    const { data: workspaces } = await supabase
      .from('sf_workspaces')
      .select('id, name, owner_user_id')
      .ilike('name', fragment)
      .limit(50);
    if (workspaces && workspaces.length) {
      const ownerIds = [...new Set(workspaces.map((w) => w.owner_user_id).filter(Boolean))];
      if (ownerIds.length) {
        const { data: owners } = await supabase
          .from('users')
          .select('id, email, business_name, created_at')
          .in('id', ownerIds);
        const byId = new Map((owners || []).map((u) => [u.id, u]));
        byWorkspace = workspaces.map((w) => ({
          workspace_id: w.id,
          workspace_name: w.name,
          owner: byId.get(w.owner_user_id) || { id: w.owner_user_id },
        }));
      }
    }
  } catch (_) {
    // sf_workspaces may not exist in some envs — defensive skip.
  }
  out.by_workspace = byWorkspace;

  // Merge user_ids across all evidence streams — UNIQUE only, sorted.
  const seen = new Set();
  for (const u of out.by_email) seen.add(u.id);
  for (const u of out.by_business_name) seen.add(u.id);
  for (const w of out.by_workspace) {
    if (w.owner && w.owner.id != null) seen.add(w.owner.id);
  }
  out.merged_unique_user_ids = [...seen].sort((a, b) => a - b);

  return out;
}

// Strict explicit-id lookup. Returns the user row or throws.
async function loadUserById(supabase, userId) {
  const idNum = Number(userId);
  if (!Number.isInteger(idNum) || idNum <= 0) {
    throw new Error(`loadUserById: invalid user_id ${userId}`);
  }
  const { data, error } = await supabase
    .from('users')
    .select('id, email, business_name, created_at')
    .eq('id', idNum)
    .maybeSingle();
  if (error) throw new Error(`tenant-resolver loadUserById: ${error.message}`);
  if (!data) throw new Error(`No user found for --user-id ${idNum}`);
  return data;
}

module.exports = { discoverCandidates, loadUserById };
