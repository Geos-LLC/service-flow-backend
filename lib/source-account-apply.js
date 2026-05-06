'use strict';

/**
 * Source-account boundary — Phase 3B apply-mode planner (pure functions).
 *
 * Decides which conversations would receive a backfilled
 * provider_account_id and groups them by target account so the CLI can
 * issue one UPDATE per (account, table) pair. Identities are explicitly
 * out of scope here.
 *
 * No supabase calls. The CLI in
 * scripts/source-account-apply-backfill.js loads classified rows from
 * lib/source-account-backfill.js, passes them through these helpers,
 * and (in --apply mode) executes the UPDATE statements via the Supabase
 * Management API so the metadata-merge stamp is atomic with the FK write.
 *
 * Hard rules (mirroring the spec):
 *   - Never overwrite a non-null provider_account_id. The SQL emitted
 *     by the CLI also enforces this with `WHERE provider_account_id IS NULL`,
 *     so the rule is doubly guaranteed.
 *   - Apply only `matched_inferred`. `matched_existing` already has the
 *     FK; ambiguous / unmatched_legacy / unknown_provider stay untouched.
 *   - Child rows (messages, calls) inherit the parent's
 *     provider_account_id. Identities are NOT touched.
 */

const APPLY_BUCKETS = new Set(['matched_inferred']);
const SKIP_BUCKETS = new Set(['matched_existing', 'ambiguous', 'unmatched_legacy', 'unknown_provider']);

/**
 * Build an apply plan from a list of `{conv, classification}` entries.
 *
 * @returns {{
 *   conversationsByAccount: Map<accountId, Array<convId>>,
 *   skipReasons: { already_set, matched_existing, ambiguous, unmatched_legacy, unknown_provider, no_account_id },
 *   accepted_count, skipped_count
 * }}
 */
function planConversationApply(classified) {
  const conversationsByAccount = new Map();
  const skipReasons = {
    already_set: 0,           // conv.provider_account_id already non-null (overwrite guard)
    matched_existing: 0,      // bucket says existing — same outcome as already_set, reported separately
    ambiguous: 0,
    unmatched_legacy: 0,
    unknown_provider: 0,
    no_account_id: 0,         // matched_inferred but classification.matched_account_id is null (unreachable)
  };
  let acceptedCount = 0;

  for (const { conv, classification } of classified) {
    // Hard guard: never overwrite a non-null FK, regardless of bucket.
    // Belt-and-braces — the SQL also has WHERE provider_account_id IS NULL,
    // but we surface it in the report so operators see it.
    if (conv.provider_account_id != null) {
      skipReasons.already_set++;
      continue;
    }

    if (classification.bucket === 'matched_existing') {
      // Should be unreachable when conv.provider_account_id is null
      // (matched_existing means the FK was already set). Still report.
      skipReasons.matched_existing++;
      continue;
    }
    if (classification.bucket === 'ambiguous') { skipReasons.ambiguous++; continue; }
    if (classification.bucket === 'unmatched_legacy') { skipReasons.unmatched_legacy++; continue; }
    if (classification.bucket === 'unknown_provider') { skipReasons.unknown_provider++; continue; }

    if (!APPLY_BUCKETS.has(classification.bucket)) {
      // Unknown bucket — fail-safe: skip.
      continue;
    }

    if (!classification.matched_account_id) {
      // matched_inferred without an id is a contract violation upstream;
      // surface it loudly but don't write garbage.
      skipReasons.no_account_id++;
      continue;
    }

    const arr = conversationsByAccount.get(classification.matched_account_id) || [];
    arr.push(conv.id);
    conversationsByAccount.set(classification.matched_account_id, arr);
    acceptedCount++;
  }

  const skippedCount = Object.values(skipReasons).reduce((a, b) => a + b, 0);

  return {
    conversationsByAccount,
    skipReasons,
    accepted_count: acceptedCount,
    skipped_count: skippedCount,
  };
}

/**
 * Generate a deterministic batch identifier. Used in the metadata stamp
 * so rollback can target only this batch's rows. Format:
 *   sab3b_YYYYMMDDTHHMMSS_<6-char random>
 */
function generateBatchId(now = new Date(), random = randomSuffix) {
  const ts = now.toISOString().replace(/[:.\-Z]/g, '').slice(0, 15);
  return `sab3b_${ts}_${random()}`;
}

function randomSuffix() {
  return Math.random().toString(36).slice(2, 8);
}

/**
 * Build the parameterized SQL for one (table, accountId, convIds, batchId)
 * tuple. Caller is responsible for executing via the Management API.
 *
 * Rules baked into the SQL:
 *   - WHERE provider_account_id IS NULL — hard idempotency + no-overwrite guard
 *   - metadata merge with COALESCE — preserves existing metadata
 *   - Stamp source_account_backfill_batch_id + source_account_backfilled_at
 *
 * Tables:
 *   'conversations' → updates communication_conversations.id IN (...)
 *   'messages'      → updates communication_messages.conversation_id IN (...)
 *   'calls'         → updates communication_calls.conversation_id IN (...)
 *
 * The IN list is interpolated as plain integers (validated below) — no
 * string values reach the SQL. accountId is also int. batchId matches
 * /^sab3b_[0-9TZ]+_[a-z0-9]+$/ which we assert.
 */
function buildBackfillSql(table, accountId, convIds, batchId, nowIso) {
  if (!Number.isInteger(accountId) || accountId <= 0) {
    throw new Error(`buildBackfillSql: accountId must be a positive int, got ${accountId}`);
  }
  if (!Array.isArray(convIds) || convIds.length === 0) {
    throw new Error('buildBackfillSql: convIds must be a non-empty array');
  }
  if (!convIds.every(id => Number.isInteger(id) && id > 0)) {
    throw new Error('buildBackfillSql: every conv id must be a positive int');
  }
  if (!/^sab3b_[0-9TZ]+_[a-z0-9]{4,12}$/.test(batchId)) {
    throw new Error(`buildBackfillSql: batchId shape rejected: ${batchId}`);
  }
  const at = (nowIso || new Date().toISOString());
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(at)) {
    throw new Error('buildBackfillSql: nowIso must be ISO-8601');
  }

  const idList = convIds.join(',');
  const stamp = `'{"source_account_backfill_batch_id": "${batchId}", "source_account_backfilled_at": "${at}"}'::jsonb`;

  if (table === 'conversations') {
    return `UPDATE public.communication_conversations
SET provider_account_id = ${accountId},
    metadata = COALESCE(metadata, '{}'::jsonb) || ${stamp},
    updated_at = NOW()
WHERE id = ANY(ARRAY[${idList}]::int[])
  AND provider_account_id IS NULL;`;
  }

  if (table === 'messages') {
    return `UPDATE public.communication_messages
SET provider_account_id = ${accountId},
    metadata = COALESCE(metadata, '{}'::jsonb) || ${stamp}
WHERE conversation_id = ANY(ARRAY[${idList}]::int[])
  AND provider_account_id IS NULL;`;
  }

  if (table === 'calls') {
    return `UPDATE public.communication_calls
SET provider_account_id = ${accountId},
    metadata = COALESCE(metadata, '{}'::jsonb) || ${stamp}
WHERE conversation_id = ANY(ARRAY[${idList}]::int[])
  AND provider_account_id IS NULL;`;
  }

  throw new Error(`buildBackfillSql: unknown table '${table}'`);
}

/**
 * Build the count SQL for the dry-run estimate of child rows that would
 * be touched. Same WHERE shape as the apply SQL — guarantees the dry-run
 * count matches what apply would actually update.
 */
function buildChildCountSql(table, convIds) {
  if (!Array.isArray(convIds) || convIds.length === 0) {
    throw new Error('buildChildCountSql: convIds must be a non-empty array');
  }
  if (!convIds.every(id => Number.isInteger(id) && id > 0)) {
    throw new Error('buildChildCountSql: every conv id must be a positive int');
  }
  const idList = convIds.join(',');
  if (table === 'messages') {
    return `SELECT COUNT(*)::int AS n FROM public.communication_messages
WHERE conversation_id = ANY(ARRAY[${idList}]::int[]) AND provider_account_id IS NULL;`;
  }
  if (table === 'calls') {
    return `SELECT COUNT(*)::int AS n FROM public.communication_calls
WHERE conversation_id = ANY(ARRAY[${idList}]::int[]) AND provider_account_id IS NULL;`;
  }
  throw new Error(`buildChildCountSql: unknown table '${table}'`);
}

/**
 * Generate the full rollback SQL for a given batch. Reverses the FK +
 * strips the batch markers from metadata. Safe to run multiple times
 * (uses the metadata marker as the WHERE filter).
 */
function buildRollbackSql(batchId) {
  if (!/^sab3b_[0-9TZ]+_[a-z0-9]{4,12}$/.test(batchId)) {
    throw new Error(`buildRollbackSql: batchId shape rejected: ${batchId}`);
  }
  return `-- Rollback Phase 3B batch ${batchId}
-- Run via Supabase Management API or psql. Order: child tables first
-- so messages/calls are unbacked before parents revert.

UPDATE public.communication_messages
SET provider_account_id = NULL,
    metadata = metadata - 'source_account_backfill_batch_id' - 'source_account_backfilled_at'
WHERE metadata->>'source_account_backfill_batch_id' = '${batchId}';

UPDATE public.communication_calls
SET provider_account_id = NULL,
    metadata = metadata - 'source_account_backfill_batch_id' - 'source_account_backfilled_at'
WHERE metadata->>'source_account_backfill_batch_id' = '${batchId}';

UPDATE public.communication_conversations
SET provider_account_id = NULL,
    metadata = metadata - 'source_account_backfill_batch_id' - 'source_account_backfilled_at',
    updated_at = NOW()
WHERE metadata->>'source_account_backfill_batch_id' = '${batchId}';`;
}

/**
 * Chunk an array of IDs to keep individual UPDATE statements bounded.
 * Postgres can handle thousands of ANY(ARRAY[...]) elements but smaller
 * statements are easier to reason about + fail granularly.
 */
function chunkIds(ids, size = 500) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

module.exports = {
  APPLY_BUCKETS,
  SKIP_BUCKETS,
  planConversationApply,
  generateBatchId,
  buildBackfillSql,
  buildChildCountSql,
  buildRollbackSql,
  chunkIds,
};
