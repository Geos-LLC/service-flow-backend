#!/usr/bin/env node
// Account Layer — PR C: apply backfill (writes Account rows + account_id links).
//
// Idempotent. Re-running picks up any rows that were missed and never
// double-creates an Account for the same Customer / SF Lead / LB Lead.
//
// Conflict policy (per operator approval 2026-06-06):
//   - Do NOT merge same-phone or same-email conflicts automatically.
//   - Keep separate Accounts.
//   - When a candidate identifier would collide with an existing
//     Account's identifier, the new Account is marked with
//     metadata.duplicate_identifier_candidate = true and the
//     conflicting identifier is recorded in
//     metadata.conflicting_identifiers[]. No account_identifier row is
//     created for the conflict.
//   - Reported at end of run.
//
// Writes ONLY:
//   - INSERT public.accounts                  (new Account row)
//   - INSERT public.account_identifiers       (one per phone/email/external_request_id)
//   - UPDATE public.customers SET account_id  (1:1)
//   - UPDATE public.leads SET account_id      (N:1)
//   - UPDATE LB "leads" SET account_id        (N:1, via Prisma)
//
// Does NOT touch:
//   - leads.status                            (no SF lead status writes)
//   - jobs.*                                  (no job mutations)
//   - LB Lead.status / lostReason / syncStatus
//   - LB Lead.sfJobOutcome / sfLeadStageName / sfCustomerId / sfLeadId
//   - LB messages, conversations, threads
//   - SF apply flags / orchestrator
//   - The 59 residual reconciliation lifecycle
//
// Usage:
//   node scripts/account-backfill-apply.js --tenant=2 [--lb-user=<uuid>] [--dry-run] [--out=PATH.json]

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ─── Args ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2).reduce((acc, a) => {
  const [k, v] = a.includes('=') ? a.split('=') : [a, true];
  acc[k.replace(/^--/, '')] = v;
  return acc;
}, {});

if (!argv.tenant) {
  console.error('--tenant=<int> is required (PR C is scoped per-tenant)');
  process.exit(1);
}
const TENANT_ID    = parseInt(String(argv.tenant), 10);
const LB_USER_UUID = argv['lb-user'] || null;            // optional override
const DRY_RUN      = !!argv['dry-run'];
const OUT_PATH     = argv.out || null;

if (isNaN(TENANT_ID)) {
  console.error('--tenant must be an integer');
  process.exit(1);
}

// ─── Env / clients ─────────────────────────────────────────────────────────
const lbDbEnv = fs.readFileSync(path.join(os.homedir(), '.lb-prod-db.env'), 'utf8');
process.env.DATABASE_URL = lbDbEnv.match(/^DATABASE_URL=(.+)$/m)[1].trim();
const sfEnv = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.sf-prod-env.json'), 'utf8'));

// Prefer the main LB checkout (which has the regenerated client including
// the new accountId field). The pause-wt worktree client is older.
const LB_PRISMA_CANDIDATES = [
  'C:/Users/HP/Desktop/Projects/Active/Development/geos-leadbridge/generated/prisma',
  'C:/Users/HP/Desktop/Projects/Active/Development/geos-leadbridge-pause-wt/generated/prisma',
];
let PrismaClient = null;
for (const p of LB_PRISMA_CANDIDATES) {
  try { ({ PrismaClient } = require(p)); break; } catch (_) {}
}
if (!PrismaClient) { console.error('LB Prisma client not found'); process.exit(1); }
const lb = new PrismaClient();
const { createClient } = require('@supabase/supabase-js');
const sf = createClient(sfEnv.SUPABASE_URL, sfEnv.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ─── Helpers ───────────────────────────────────────────────────────────────
function phone10(s) {
  if (!s) return null;
  const d = String(s).replace(/\D+/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
}
function emailNorm(s) {
  if (!s || typeof s !== 'string' || !s.includes('@')) return null;
  const x = s.trim().toLowerCase();
  if (/@messaging\.yelp\.com$/i.test(x)) return null;
  if (/@thumbtack\.com$/i.test(x))       return null;
  return x;
}
function nowIso() { return new Date().toISOString(); }

async function sfPaged(table, columns, filter, orderColumn = 'id') {
  const all = [];
  let from = 0;
  const PAGE = 1000;
  /* eslint no-constant-condition: 0 */
  while (true) {
    let q = sf.from(table).select(columns).order(orderColumn, { ascending: true }).range(from, from + PAGE - 1);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error('SF ' + table + ' fetch: ' + error.message);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// ─── Resolver state ────────────────────────────────────────────────────────
// In-memory cache: identifier_value → existing account_id
// Populated lazily from public.account_identifiers as we go, plus from rows
// we create during this run.
const identifierCache = new Map();   // key='type:value' → account_id
const accountSummary = new Map();    // account_id → { source, customer_ids, sf_lead_ids, lb_lead_ids, identifiers, conflicts }
let conflictCount = 0;

async function loadExistingIdentifiers() {
  process.stderr.write('loading existing account_identifiers… ');
  const rows = await sfPaged(
    'account_identifiers',
    'account_id, identifier_type, identifier_value',
    q => q.eq('tenant_id', TENANT_ID).eq('is_active', true),
    'id',
  );
  for (const r of rows) {
    identifierCache.set(r.identifier_type + ':' + r.identifier_value, r.account_id);
  }
  process.stderr.write(rows.length + '\n');
}

function trackAccount(accountId, source) {
  if (!accountSummary.has(accountId)) {
    accountSummary.set(accountId, {
      account_id: accountId,
      source,
      customer_ids: new Set(),
      sf_lead_ids: new Set(),
      lb_lead_ids: new Set(),
      identifiers_added: 0,
      conflicting_identifiers: [],
    });
  }
  return accountSummary.get(accountId);
}

async function createAccount(displayName, lifecycleState, firstSeenAt, becameCustomerAt, primaryPhone, primaryEmail, source) {
  if (DRY_RUN) {
    const fakeId = '__DRY_' + (createAccount._counter++).toString().padStart(8, '0');
    trackAccount(fakeId, source);
    return fakeId;
  }
  const { data, error } = await sf.from('accounts').insert({
    tenant_id:           TENANT_ID,
    display_name:        displayName,
    type:                'individual',
    lifecycle_state:     lifecycleState,
    primary_phone:       primaryPhone,
    primary_email:       primaryEmail,
    first_seen_at:       firstSeenAt,
    became_customer_at:  becameCustomerAt,
    metadata:            {},
  }).select('id').single();
  if (error) throw new Error('INSERT account failed: ' + error.message);
  trackAccount(data.id, source);
  return data.id;
}
createAccount._counter = 1;

async function insertIdentifier(accountId, type, value, source, confidence) {
  if (!value) return { inserted: false, conflict: false };
  const key = type + ':' + value;
  // Already owned by another Account?
  const existingOwner = identifierCache.get(key);
  if (existingOwner && existingOwner !== accountId) {
    // Conflict — mark on the NEW account's metadata at end of customer pass.
    const summary = trackAccount(accountId, 'unknown');
    summary.conflicting_identifiers.push({
      identifier_type: type,
      identifier_value: value,
      conflicts_with_account: existingOwner,
    });
    conflictCount++;
    return { inserted: false, conflict: true, existingOwner };
  }
  if (existingOwner === accountId) {
    // Already on this account — nothing to do, idempotent.
    return { inserted: false, conflict: false };
  }
  if (DRY_RUN) {
    identifierCache.set(key, accountId);
    const summary = trackAccount(accountId, 'unknown');
    summary.identifiers_added++;
    return { inserted: true, conflict: false };
  }
  const { error } = await sf.from('account_identifiers').insert({
    account_id:        accountId,
    tenant_id:         TENANT_ID,
    identifier_type:   type,
    identifier_value:  value,
    identifier_source: source,
    confidence:        confidence || 'high',
    is_active:         true,
    first_seen_at:     nowIso(),
    last_seen_at:      nowIso(),
  });
  if (error) {
    // Concurrent insert won the unique race — reload from DB
    if (error.code === '23505') {
      const { data: existing } = await sf.from('account_identifiers')
        .select('account_id')
        .eq('tenant_id', TENANT_ID).eq('identifier_type', type).eq('identifier_value', value).eq('is_active', true).maybeSingle();
      if (existing && existing.account_id !== accountId) {
        identifierCache.set(key, existing.account_id);
        const summary = trackAccount(accountId, 'unknown');
        summary.conflicting_identifiers.push({
          identifier_type: type,
          identifier_value: value,
          conflicts_with_account: existing.account_id,
        });
        conflictCount++;
        return { inserted: false, conflict: true, existingOwner: existing.account_id };
      }
      return { inserted: false, conflict: false };
    }
    throw new Error('INSERT identifier failed: ' + error.message + ' (' + JSON.stringify({ type, value, accountId }) + ')');
  }
  identifierCache.set(key, accountId);
  const summary = trackAccount(accountId, 'unknown');
  summary.identifiers_added++;
  return { inserted: true, conflict: false };
}

async function resolveExistingAccountByIdentifiers(idTuples) {
  for (const t of idTuples) {
    if (!t.value) continue;
    const hit = identifierCache.get(t.type + ':' + t.value);
    if (hit) return hit;
  }
  return null;
}

async function setCustomerAccountId(customerId, accountId) {
  if (DRY_RUN) return;
  const { error } = await sf.from('customers').update({ account_id: accountId }).eq('id', customerId).is('account_id', null);
  if (error) throw new Error('UPDATE customer.account_id failed: ' + error.message);
}
async function setSfLeadAccountId(leadId, accountId) {
  if (DRY_RUN) return;
  const { error } = await sf.from('leads').update({ account_id: accountId }).eq('id', leadId).is('account_id', null);
  if (error) throw new Error('UPDATE sf_lead.account_id failed: ' + error.message);
}
async function setLbLeadAccountId(lbLeadId, accountId) {
  if (DRY_RUN) return;
  // Use raw SQL so accountId is treated as uuid by Postgres
  await lb.$executeRaw`UPDATE leads SET account_id = ${accountId}::uuid WHERE id = ${lbLeadId} AND account_id IS NULL`;
}

async function flagDuplicateConflicts() {
  if (DRY_RUN) return;
  for (const summary of accountSummary.values()) {
    if (summary.conflicting_identifiers.length === 0) continue;
    if (String(summary.account_id).startsWith('__DRY_')) continue;
    const { error } = await sf.from('accounts').update({
      metadata: {
        duplicate_identifier_candidate: true,
        conflicting_identifiers:        summary.conflicting_identifiers,
        conflict_recorded_at:           nowIso(),
      },
      updated_at: nowIso(),
    }).eq('id', summary.account_id);
    if (error) throw new Error('UPDATE accounts.metadata failed: ' + error.message);
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────
(async () => {
  console.log('Account Layer — PR C apply backfill');
  console.log('Generated:    ' + nowIso());
  console.log('Tenant:       ' + TENANT_ID);
  console.log('LB user UUID: ' + (LB_USER_UUID || '(auto-discover from data)'));
  console.log('Mode:         ' + (DRY_RUN ? 'DRY-RUN (no writes)' : 'APPLY (live writes)'));
  console.log('');

  await loadExistingIdentifiers();

  // Discover LB user UUIDs that link to this tenant (if not explicitly passed).
  let lbUserUuids = LB_USER_UUID ? [LB_USER_UUID] : [];
  if (lbUserUuids.length === 0) {
    process.stderr.write('discovering LB user UUIDs for tenant ' + TENANT_ID + '… ');
    const allLbUsers = await lb.lead.groupBy({ by: ['userId'], _count: { _all: true } });
    for (const u of allLbUsers) {
      const link = await lb.lead.findFirst({
        where: { userId: u.userId, OR: [{ sfCustomerId: { not: null } }, { sfLeadId: { not: null } }] },
        select: { sfCustomerId: true, sfLeadId: true },
      });
      if (!link) continue;
      let tid = null;
      if (link.sfCustomerId) {
        const cid = parseInt(link.sfCustomerId, 10);
        if (!isNaN(cid)) {
          const { data } = await sf.from('customers').select('user_id').eq('id', cid).maybeSingle();
          if (data) tid = data.user_id;
        }
      }
      if (!tid && link.sfLeadId) {
        const lid = parseInt(link.sfLeadId, 10);
        if (!isNaN(lid)) {
          const { data } = await sf.from('leads').select('user_id').eq('id', lid).maybeSingle();
          if (data) tid = data.user_id;
        }
      }
      if (tid === TENANT_ID) lbUserUuids.push(u.userId);
    }
    process.stderr.write(lbUserUuids.join(',') + '\n');
  }
  if (lbUserUuids.length === 0) {
    console.warn('WARNING: no LB user UUIDs mapped to tenant ' + TENANT_ID + ' — LB join will be skipped');
  }

  // ── STEP 1 — Customers seed Accounts ─────────────────────────────────────
  process.stderr.write('STEP 1 customers… ');
  const customers = await sfPaged(
    'customers',
    'id, first_name, last_name, phone, email, account_id, created_at',
    q => q.eq('user_id', TENANT_ID).order('created_at', { ascending: true }),
    'created_at',
  );
  let s1_new = 0, s1_skip = 0;
  const customerToAccount = new Map();   // customer_id → account_id

  for (const c of customers) {
    if (c.account_id) {
      s1_skip++;
      customerToAccount.set(c.id, c.account_id);
      const summary = trackAccount(c.account_id, 'sf_customer');
      summary.customer_ids.add(c.id);
      continue;
    }
    const ph = phone10(c.phone);
    const em = emailNorm(c.email);
    const name = ((c.first_name || '') + ' ' + (c.last_name || '')).trim() || ('Customer ' + c.id);
    // Customers always seed a FRESH Account (1:1 with Customer is the rule;
    // identifier conflicts are surfaced rather than auto-merged).
    const accountId = await createAccount(
      name,
      'customer',
      c.created_at,
      c.created_at,
      c.phone || null,
      c.email || null,
      'sf_customer',
    );
    customerToAccount.set(c.id, accountId);
    const summary = trackAccount(accountId, 'sf_customer');
    summary.customer_ids.add(c.id);
    await setCustomerAccountId(c.id, accountId);
    if (ph) await insertIdentifier(accountId, 'phone', ph, 'sf_customer', 'high');
    if (em) await insertIdentifier(accountId, 'email', em, 'sf_customer', 'high');
    s1_new++;
  }
  process.stderr.write('new=' + s1_new + ' already_linked=' + s1_skip + '\n');

  // ── STEP 2 — SF leads (converted attach, unconverted resolve-or-create) ──
  process.stderr.write('STEP 2 sf_leads… ');
  const sfLeads = await sfPaged(
    'leads',
    'id, first_name, last_name, phone, email, account_id, converted_customer_id, lb_external_request_id, created_at',
    q => q.eq('user_id', TENANT_ID).order('created_at', { ascending: true }),
    'created_at',
  );
  let s2_attached_to_customer = 0, s2_resolved = 0, s2_new_account = 0, s2_skip = 0;
  const sfLeadToAccount = new Map();

  for (const lead of sfLeads) {
    if (lead.account_id) {
      s2_skip++;
      sfLeadToAccount.set(lead.id, lead.account_id);
      const summary = trackAccount(lead.account_id, 'unknown');
      summary.sf_lead_ids.add(lead.id);
      continue;
    }
    let accountId = null;
    let pathTaken = null;
    if (lead.converted_customer_id) {
      accountId = customerToAccount.get(lead.converted_customer_id) || null;
      if (accountId) { pathTaken = 'attached_to_customer'; s2_attached_to_customer++; }
    }
    if (!accountId) {
      const ph = phone10(lead.phone);
      const em = emailNorm(lead.email);
      const ext = lead.lb_external_request_id;
      const idTuples = [
        ext ? { type: 'external_request_id', value: ext } : null,
        ph  ? { type: 'phone',                value: ph  } : null,
        em  ? { type: 'email',                value: em  } : null,
      ].filter(Boolean);
      accountId = await resolveExistingAccountByIdentifiers(idTuples);
      if (accountId) { pathTaken = 'resolved'; s2_resolved++; }
    }
    if (!accountId) {
      const name = ((lead.first_name || '') + ' ' + (lead.last_name || '')).trim() || ('SF Lead ' + lead.id);
      accountId = await createAccount(
        name,
        'lead',
        lead.created_at,
        null,
        lead.phone || null,
        lead.email || null,
        'sf_lead',
      );
      pathTaken = 'created'; s2_new_account++;
    }
    sfLeadToAccount.set(lead.id, accountId);
    const summary = trackAccount(accountId, 'sf_lead');
    summary.sf_lead_ids.add(lead.id);
    await setSfLeadAccountId(lead.id, accountId);
    const ph = phone10(lead.phone);
    const em = emailNorm(lead.email);
    if (ph)                              await insertIdentifier(accountId, 'phone',               ph, 'sf_lead', 'high');
    if (em)                              await insertIdentifier(accountId, 'email',               em, 'sf_lead', 'high');
    if (lead.lb_external_request_id)     await insertIdentifier(accountId, 'external_request_id', lead.lb_external_request_id, 'sf_lead', 'exact');
  }
  process.stderr.write('attached=' + s2_attached_to_customer + ' resolved=' + s2_resolved + ' new=' + s2_new_account + ' already_linked=' + s2_skip + '\n');

  // ── STEP 3 — LB inquiries ────────────────────────────────────────────────
  process.stderr.write('STEP 3 lb_leads… ');
  let lbLeads = [];
  if (lbUserUuids.length > 0) {
    lbLeads = await lb.lead.findMany({
      where: { userId: { in: lbUserUuids } },
      select: {
        id: true, customerPhone: true, customerEmail: true,
        externalRequestId: true, customerName: true,
        sfCustomerId: true, sfLeadId: true, accountId: true,
        createdAt: true,
      },
    });
  }
  let s3_via_cust = 0, s3_via_lead = 0, s3_resolved = 0, s3_new = 0, s3_skip = 0;
  for (const l of lbLeads) {
    if (l.accountId) {
      s3_skip++;
      const summary = trackAccount(l.accountId, 'unknown');
      summary.lb_lead_ids.add(l.id);
      continue;
    }
    let accountId = null;
    if (l.sfCustomerId) {
      const cid = parseInt(l.sfCustomerId, 10);
      if (!isNaN(cid)) accountId = customerToAccount.get(cid) || null;
      if (accountId) s3_via_cust++;
    }
    if (!accountId && l.sfLeadId) {
      const lid = parseInt(l.sfLeadId, 10);
      if (!isNaN(lid)) accountId = sfLeadToAccount.get(lid) || null;
      if (accountId) s3_via_lead++;
    }
    if (!accountId) {
      const ph = phone10(l.customerPhone);
      const em = emailNorm(l.customerEmail);
      const ext = l.externalRequestId;
      const idTuples = [
        ext ? { type: 'external_request_id', value: ext } : null,
        ph  ? { type: 'phone',                value: ph  } : null,
        em  ? { type: 'email',                value: em  } : null,
      ].filter(Boolean);
      accountId = await resolveExistingAccountByIdentifiers(idTuples);
      if (accountId) s3_resolved++;
    }
    if (!accountId) {
      const name = (l.customerName || 'LB Lead ' + l.id.slice(0, 8)).trim();
      accountId = await createAccount(
        name,
        'lead',
        l.createdAt,
        null,
        l.customerPhone || null,
        l.customerEmail || null,
        'lb_lead',
      );
      s3_new++;
    }
    const summary = trackAccount(accountId, 'lb_lead');
    summary.lb_lead_ids.add(l.id);
    await setLbLeadAccountId(l.id, accountId);
    const ph = phone10(l.customerPhone);
    const em = emailNorm(l.customerEmail);
    if (ph)                  await insertIdentifier(accountId, 'phone',               ph, 'lb_inquiry', 'high');
    if (em)                  await insertIdentifier(accountId, 'email',               em, 'lb_inquiry', 'high');
    if (l.externalRequestId) await insertIdentifier(accountId, 'external_request_id', l.externalRequestId, 'lb_inquiry', 'exact');
  }
  process.stderr.write('via_cust=' + s3_via_cust + ' via_sflead=' + s3_via_lead + ' resolved=' + s3_resolved + ' new=' + s3_new + ' already_linked=' + s3_skip + '\n');

  // ── STEP 4 — Flag duplicate-identifier conflicts on accounts.metadata ────
  await flagDuplicateConflicts();

  // ── Summary ──────────────────────────────────────────────────────────────
  const summaryTotals = {
    tenant_id:                   TENANT_ID,
    mode:                        DRY_RUN ? 'dry-run' : 'apply',
    lb_user_uuids:               lbUserUuids,
    customers:                   { total: customers.length,  new_accounts: s1_new, already_linked: s1_skip },
    sf_leads:                    { total: sfLeads.length,    attached_to_customer: s2_attached_to_customer, resolved_to_existing: s2_resolved, new_accounts: s2_new_account, already_linked: s2_skip },
    lb_leads:                    { total: lbLeads.length,    via_customer: s3_via_cust, via_sf_lead: s3_via_lead, resolved_to_existing: s3_resolved, new_accounts: s3_new, already_linked: s3_skip },
    accounts_touched:            accountSummary.size,
    identifier_conflicts:        conflictCount,
  };
  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('SUMMARY');
  console.log('══════════════════════════════════════════════════════════════════');
  console.log(JSON.stringify(summaryTotals, null, 2));

  // List conflicts
  if (conflictCount > 0) {
    console.log('\n══════════════════════════════════════════════════════════════════');
    console.log('IDENTIFIER CONFLICTS (kept separate per policy)');
    console.log('══════════════════════════════════════════════════════════════════');
    const conflictRows = [];
    for (const s of accountSummary.values()) {
      for (const c of s.conflicting_identifiers) {
        conflictRows.push({ account_id: s.account_id, ...c });
      }
    }
    conflictRows.slice(0, 50).forEach(r => console.log('  ' + JSON.stringify(r)));
    if (conflictRows.length > 50) console.log('  …+' + (conflictRows.length - 50) + ' more');
  }

  // Verification
  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('VERIFICATION');
  console.log('══════════════════════════════════════════════════════════════════');
  if (!DRY_RUN) {
    const [{ count: cWith }] = await sfRpcCount('customers', 'user_id', TENANT_ID, true);
    const [{ count: cTotal }] = await sfRpcCount('customers', 'user_id', TENANT_ID, false);
    const [{ count: lWith }] = await sfRpcCount('leads', 'user_id', TENANT_ID, true);
    const [{ count: lTotal }] = await sfRpcCount('leads', 'user_id', TENANT_ID, false);
    let lbWith = 0, lbTotal = 0;
    if (lbUserUuids.length > 0) {
      lbTotal = await lb.lead.count({ where: { userId: { in: lbUserUuids } } });
      lbWith  = await lb.lead.count({ where: { userId: { in: lbUserUuids }, accountId: { not: null } } });
    }
    const acctWithMultiCust = await sfMultiCustomerAccounts();
    console.log('  customers w/ account_id:        ' + cWith + '/' + cTotal + '  (' + pct(cWith, cTotal) + ')');
    console.log('  sf_leads w/ account_id:         ' + lWith + '/' + lTotal + '  (' + pct(lWith, lTotal) + ')');
    console.log('  LB leads w/ account_id (mapped):' + lbWith + '/' + lbTotal + '  (' + pct(lbWith, lbTotal) + ')');
    console.log('  accounts w/ >1 customer:        ' + acctWithMultiCust);
    summaryTotals.verification = {
      customers_with_account_id:  { with: cWith,  total: cTotal,  pct: pct(cWith, cTotal) },
      sf_leads_with_account_id:   { with: lWith,  total: lTotal,  pct: pct(lWith, lTotal) },
      lb_leads_with_account_id:   { with: lbWith, total: lbTotal, pct: pct(lbWith, lbTotal) },
      accounts_with_multi_customer: acctWithMultiCust,
    };
  } else {
    console.log('  (skipped in dry-run mode)');
  }

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('SAFETY CONFIRMATION');
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  ✓ no customer messages sent');
  console.log('  ✓ no Lead.status writes');
  console.log('  ✓ no sfJobOutcome writes');
  console.log('  ✓ no attachLbLink invocations');
  console.log('  ✓ no matcher / apply / residual reconciliation triggered');
  console.log('  ✓ apply flags untouched');

  if (OUT_PATH) {
    fs.writeFileSync(OUT_PATH, JSON.stringify({
      summary:           summaryTotals,
      conflict_details:  [...accountSummary.values()].filter(s => s.conflicting_identifiers.length > 0).map(s => ({ account_id: s.account_id, conflicting_identifiers: s.conflicting_identifiers })),
    }, null, 2));
    console.log('\nfull JSON written to: ' + OUT_PATH);
  }

  await lb.$disconnect();
})().catch(e => { console.error('FATAL ' + e.message + '\n' + e.stack); lb.$disconnect().finally(() => process.exit(1)); });

function pct(n, d) { return d === 0 ? '0%' : ((100 * n) / d).toFixed(1) + '%'; }

async function sfRpcCount(table, col, val, requireAccountId) {
  // Supabase count via head:true returns count in response header
  let q = sf.from(table).select('*', { count: 'exact', head: true }).eq(col, val);
  if (requireAccountId) q = q.not('account_id', 'is', null);
  const { count, error } = await q;
  if (error) throw new Error('count ' + table + ': ' + error.message);
  return [{ count }];
}

async function sfMultiCustomerAccounts() {
  // Accounts with >1 customer attached.
  const { data, error } = await sf.rpc('exec_sql_if_present', {}); // intentionally absent — fall back to a JS aggregation
  if (error || !data) {
    // Fallback: query account_id from customers grouped via JS.
    let from = 0;
    const byAcct = new Map();
    while (true) {
      const { data: rows } = await sf.from('customers').select('id, account_id').eq('user_id', TENANT_ID).not('account_id', 'is', null).range(from, from + 999);
      if (!rows || rows.length === 0) break;
      for (const r of rows) byAcct.set(r.account_id, (byAcct.get(r.account_id) || 0) + 1);
      if (rows.length < 1000) break;
      from += 1000;
    }
    let n = 0;
    for (const c of byAcct.values()) if (c > 1) n++;
    return n;
  }
  return data;
}
