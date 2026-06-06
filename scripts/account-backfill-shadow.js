#!/usr/bin/env node
// Account Layer — PR B: read-only shadow backfill report.
//
// Projects what PR C's apply backfill would write, without performing
// any DB writes. Walks SF Customers → SF Leads → LB Inquiries in that
// order (Customer is the most-trustworthy identity anchor), builds a
// projected account graph, detects identifier conflicts, and reports
// counts + the 59-residual re-classification under projected account_id.
//
// SAFETY:
//   - Read-only against SF Supabase (service role key, SELECT only).
//   - Read-only against LB Prisma (no $executeRaw, no upsert).
//   - No customer messaging, no Lead.status writes, no sfJobOutcome
//     writes, no attachLbLink, no apply-flag flips.
//   - SF_HISTORICAL_FEEDBACK_APPLY_ENABLED and
//     SF_HISTORICAL_SYNC_APPLY_ENABLED are not touched.
//
// Inputs (env files in $HOME — same as full-lb-identity-reconciliation.js):
//   ~/.lb-prod-db.env       → DATABASE_URL=...
//   ~/.sf-prod-env.json     → { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY }
//
// Output: structured report on stdout + optional JSON dump on disk.
//
// Usage:
//   node scripts/account-backfill-shadow.js [--tenants=2,3,...] [--out=path.json]
//   node scripts/account-backfill-shadow.js --residuals=$HOME/sf-dry59.json
//     → also re-classifies the 59 residuals under projected account_id.

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

const TENANT_FILTER = argv.tenants
  ? String(argv.tenants).split(',').map(t => parseInt(t.trim(), 10)).filter(n => !isNaN(n))
  : null;
const OUT_PATH      = argv.out || null;
const RESIDUALS_PATH = argv.residuals || null;

// ─── Env / clients ─────────────────────────────────────────────────────────
const lbDbEnvPath = path.join(os.homedir(), '.lb-prod-db.env');
const sfEnvPath   = path.join(os.homedir(), '.sf-prod-env.json');
if (!fs.existsSync(lbDbEnvPath)) {
  console.error('Missing ' + lbDbEnvPath + ' (DATABASE_URL for LB Prisma)');
  process.exit(1);
}
if (!fs.existsSync(sfEnvPath)) {
  console.error('Missing ' + sfEnvPath + ' (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)');
  process.exit(1);
}

const lbDbEnv = fs.readFileSync(lbDbEnvPath, 'utf8');
process.env.DATABASE_URL = lbDbEnv.match(/^DATABASE_URL=(.+)$/m)[1].trim();

const sfEnv = JSON.parse(fs.readFileSync(sfEnvPath, 'utf8'));

// LB Prisma client (use whichever generated client is available)
const LB_PRISMA_CANDIDATES = [
  path.resolve(__dirname, '..', '..', 'geos-leadbridge-pause-wt', 'generated', 'prisma'),
  path.resolve(__dirname, '..', '..', '..', 'geos-leadbridge', 'generated', 'prisma'),
  'C:/Users/HP/Desktop/Projects/Active/Development/geos-leadbridge-pause-wt/generated/prisma',
  'C:/Users/HP/Desktop/Projects/Active/Development/geos-leadbridge/generated/prisma',
];
let PrismaClient = null;
for (const p of LB_PRISMA_CANDIDATES) {
  try { ({ PrismaClient } = require(p)); break; } catch (_) {}
}
if (!PrismaClient) {
  console.error('Could not load LB Prisma client. Tried:\n  ' + LB_PRISMA_CANDIDATES.join('\n  '));
  process.exit(1);
}
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
  if (/@messaging\.yelp\.com$/i.test(x)) return null;   // Yelp proxies don't anchor identity
  if (/@thumbtack\.com$/i.test(x))       return null;   // TT proxies too
  return x;
}
function nowIso() { return new Date().toISOString(); }
function pct(n, d) { return d === 0 ? '0%' : ((100 * n) / d).toFixed(1) + '%'; }

// SF page-fetch (Supabase 1000-row cap)
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

// ─── Projection ────────────────────────────────────────────────────────────
class ProjectedAccount {
  constructor(tenantId, seedSource, displayName) {
    this.projectedId       = 'PA_' + (ProjectedAccount._counter++);
    this.tenantId          = tenantId;
    this.displayName       = displayName || '(unknown)';
    this.type              = 'individual';
    this.lifecycleState    = 'lead';
    this.firstSeenAt       = null;
    this.becameCustomerAt  = null;
    this.identifiers       = new Map();   // key=type:value → { type, value, sources:Set, confidence }
    this.customerIds       = new Set();
    this.sfLeadIds         = new Set();
    this.lbLeadIds         = new Set();
    this.seedSource        = seedSource;
    this.primaryPhone      = null;
    this.primaryEmail      = null;
  }
  addIdentifier(type, value, source, confidence = 'high') {
    if (!value) return;
    const key = type + ':' + value;
    if (!this.identifiers.has(key)) {
      this.identifiers.set(key, { type, value, sources: new Set([source]), confidence });
    } else {
      this.identifiers.get(key).sources.add(source);
    }
  }
  observeAt(ts) {
    if (!ts) return;
    const t = new Date(ts);
    if (!this.firstSeenAt || t < this.firstSeenAt) this.firstSeenAt = t;
  }
}
ProjectedAccount._counter = 1;

class TenantProjection {
  constructor(tenantId, lbUserUuid) {
    this.tenantId           = tenantId;
    this.lbUserUuid         = lbUserUuid;
    this.accounts           = [];                  // ProjectedAccount[]
    this.byIdentifier       = new Map();           // 'type:value' → ProjectedAccount
    this.customerToAccount  = new Map();           // sfCustomerId → ProjectedAccount
    this.sfLeadToAccount    = new Map();
    this.lbLeadToAccount    = new Map();
    this.conflicts          = {
      sameIdentifierMultipleCustomersDuringSeed: [], // {identifier, customerIds[]}
      customerMappedToMultipleAccounts:           [], // {customerId, accountIds[]}
      accountClaimingMultipleCustomers:           [], // {accountId, customerIds[]}
    };
  }
  resolveByIdentifiers(idTuples) {
    for (const t of idTuples) {
      if (!t.value) continue;
      const key = t.type + ':' + t.value;
      const hit = this.byIdentifier.get(key);
      if (hit) return hit;
    }
    return null;
  }
  indexAccountIdentifiers(acct) {
    for (const id of acct.identifiers.values()) {
      const key = id.type + ':' + id.value;
      const existing = this.byIdentifier.get(key);
      if (existing && existing !== acct) {
        // Conflict — already pointed at a different account
        this.conflicts.sameIdentifierMultipleCustomersDuringSeed.push({
          identifier: key,
          accountIds: [existing.projectedId, acct.projectedId],
        });
        // Keep first claim
        continue;
      }
      this.byIdentifier.set(key, acct);
    }
  }
}

// ─── Tenant discovery ──────────────────────────────────────────────────────
// Approach:
//   1. SF tenants = distinct user_id across customers + leads
//   2. SF↔LB user mapping derived from data: for each LB user that has any
//      linked lead (sfCustomerId or sfLeadId populated), look up the SF
//      customer/lead and record its user_id. The LB user UUID is mapped to
//      that SF user_id.
//   3. LB users with zero SF-linked leads (no sfCustomerId / sfLeadId on any
//      lead) are NOT mapped to any SF tenant by this script — we can't infer
//      which SF tenant they belong to from data alone. They get reported as
//      "unmapped LB users" in the summary.
async function discoverTenants() {
  const ids = new Set();
  // Distinct user_ids
  let from = 0;
  while (true) {
    const { data } = await sf.from('customers').select('user_id').range(from, from + 999);
    if (!data || data.length === 0) break;
    for (const r of data) if (r.user_id) ids.add(r.user_id);
    if (data.length < 1000) break;
    from += 1000;
  }
  from = 0;
  while (true) {
    const { data } = await sf.from('leads').select('user_id').range(from, from + 999);
    if (!data || data.length === 0) break;
    for (const r of data) if (r.user_id) ids.add(r.user_id);
    if (data.length < 1000) break;
    from += 1000;
  }

  // SF↔LB user mapping from LB lead linkage data
  process.stderr.write('discovering SF↔LB user mapping… ');
  const lbToTenant   = new Map();
  const unmappedLb   = new Set();
  const allLbUserIds = await lb.lead.groupBy({ by: ['userId'], _count: { _all: true } });
  for (const u of allLbUserIds) {
    // Find one linked LB lead → resolve to SF tenant
    const link = await lb.lead.findFirst({
      where: { userId: u.userId, OR: [{ sfCustomerId: { not: null } }, { sfLeadId: { not: null } }] },
      select: { sfCustomerId: true, sfLeadId: true },
    });
    if (!link) { unmappedLb.add(u.userId); continue; }
    let tenantId = null;
    if (link.sfCustomerId) {
      const cid = parseInt(link.sfCustomerId, 10);
      if (!isNaN(cid)) {
        const { data } = await sf.from('customers').select('user_id').eq('id', cid).maybeSingle();
        if (data) tenantId = data.user_id;
      }
    }
    if (!tenantId && link.sfLeadId) {
      const lid = parseInt(link.sfLeadId, 10);
      if (!isNaN(lid)) {
        const { data } = await sf.from('leads').select('user_id').eq('id', lid).maybeSingle();
        if (data) tenantId = data.user_id;
      }
    }
    if (tenantId) { lbToTenant.set(u.userId, tenantId); ids.add(tenantId); }
    else { unmappedLb.add(u.userId); }
  }
  process.stderr.write('mapped=' + lbToTenant.size + ' unmapped=' + unmappedLb.size + '\n');

  const tenants = [...ids].sort((a, b) => a - b);
  return { tenants, lbToTenant, unmappedLb };
}

// ─── Build projection for one tenant ──────────────────────────────────────
async function projectTenant(tenantId, lbUserUuidsForTenant) {
  const proj = new TenantProjection(tenantId, lbUserUuidsForTenant[0] || null);

  // STEP 1 — Customers seed Accounts
  process.stderr.write('  tenant ' + tenantId + ' • customers… ');
  const customers = await sfPaged(
    'customers',
    'id, first_name, last_name, phone, email, lb_lead_id, acquisition_source, source, created_at',
    q => q.eq('user_id', tenantId),
  );
  process.stderr.write(customers.length + '\n');

  for (const c of customers) {
    const name = ((c.first_name || '') + ' ' + (c.last_name || '')).trim() || ('Customer ' + c.id);
    const acct = new ProjectedAccount(tenantId, 'sf_customer', name);
    acct.lifecycleState   = 'customer';
    acct.becameCustomerAt = c.created_at ? new Date(c.created_at) : null;
    acct.observeAt(c.created_at);
    acct.customerIds.add(c.id);
    acct.primaryPhone     = c.phone || null;
    acct.primaryEmail     = c.email || null;
    const ph = phone10(c.phone);
    const em = emailNorm(c.email);
    if (ph) acct.addIdentifier('phone', ph, 'sf_customer');
    if (em) acct.addIdentifier('email', em, 'sf_customer');
    proj.accounts.push(acct);
    proj.customerToAccount.set(c.id, acct);
    proj.indexAccountIdentifiers(acct);
  }

  // STEP 2 — SF leads (converted → existing Account, unconverted → resolve or new)
  process.stderr.write('  tenant ' + tenantId + ' • sf_leads… ');
  const sfLeads = await sfPaged(
    'leads',
    'id, first_name, last_name, phone, email, source, lb_external_request_id, converted_customer_id, created_at',
    q => q.eq('user_id', tenantId),
  );
  process.stderr.write(sfLeads.length + '\n');

  for (const lead of sfLeads) {
    let acct = null;
    if (lead.converted_customer_id) {
      acct = proj.customerToAccount.get(lead.converted_customer_id) || null;
    }
    if (!acct) {
      const ph = phone10(lead.phone);
      const em = emailNorm(lead.email);
      const ext = lead.lb_external_request_id;
      const idTuples = [
        ext ? { type: 'external_request_id', value: ext } : null,
        ph  ? { type: 'phone',                value: ph  } : null,
        em  ? { type: 'email',                value: em  } : null,
      ].filter(Boolean);
      acct = proj.resolveByIdentifiers(idTuples);
    }
    if (!acct) {
      const name = ((lead.first_name || '') + ' ' + (lead.last_name || '')).trim() || ('SF Lead ' + lead.id);
      acct = new ProjectedAccount(tenantId, 'sf_lead', name);
      acct.lifecycleState = 'lead';
      proj.accounts.push(acct);
    }
    acct.observeAt(lead.created_at);
    acct.sfLeadIds.add(lead.id);
    const ph = phone10(lead.phone);
    const em = emailNorm(lead.email);
    if (ph) acct.addIdentifier('phone', ph, 'sf_lead');
    if (em) acct.addIdentifier('email', em, 'sf_lead');
    if (lead.lb_external_request_id) acct.addIdentifier('external_request_id', lead.lb_external_request_id, 'sf_lead', 'exact');
    proj.sfLeadToAccount.set(lead.id, acct);
    proj.indexAccountIdentifiers(acct);
  }

  // STEP 3 — LB leads → resolve via sfCustomerId / sfLeadId / phone / email / externalRequestId
  if (lbUserUuidsForTenant && lbUserUuidsForTenant.length > 0) {
    process.stderr.write('  tenant ' + tenantId + ' • lb_leads…');
    const lbLeads = await lb.lead.findMany({
      where: { userId: { in: lbUserUuidsForTenant } },
      select: {
        id: true, userId: true, customerPhone: true, customerEmail: true,
        externalRequestId: true, customerName: true, platform: true, syncStatus: true,
        sfCustomerId: true, sfLeadId: true, createdAt: true,
      },
    });
    process.stderr.write(' ' + lbLeads.length + '\n');

    for (const l of lbLeads) {
      let acct = null;
      if (l.sfCustomerId) {
        const cid = parseInt(l.sfCustomerId, 10);
        if (!isNaN(cid)) acct = proj.customerToAccount.get(cid) || null;
      }
      if (!acct && l.sfLeadId) {
        const lid = parseInt(l.sfLeadId, 10);
        if (!isNaN(lid)) acct = proj.sfLeadToAccount.get(lid) || null;
      }
      if (!acct) {
        const ph = phone10(l.customerPhone);
        const em = emailNorm(l.customerEmail);
        const ext = l.externalRequestId;
        const idTuples = [
          ext ? { type: 'external_request_id', value: ext } : null,
          ph  ? { type: 'phone',                value: ph  } : null,
          em  ? { type: 'email',                value: em  } : null,
        ].filter(Boolean);
        acct = proj.resolveByIdentifiers(idTuples);
      }
      if (!acct) {
        const name = (l.customerName || 'LB Lead ' + l.id.slice(0, 8)).trim();
        acct = new ProjectedAccount(tenantId, 'lb_lead', name);
        acct.lifecycleState = 'lead';
        proj.accounts.push(acct);
      }
      acct.observeAt(l.createdAt);
      acct.lbLeadIds.add(l.id);
      const ph = phone10(l.customerPhone);
      const em = emailNorm(l.customerEmail);
      if (ph) acct.addIdentifier('phone', ph, 'lb_inquiry');
      if (em) acct.addIdentifier('email', em, 'lb_inquiry');
      if (l.externalRequestId) acct.addIdentifier('external_request_id', l.externalRequestId, 'lb_inquiry', 'exact');
      proj.lbLeadToAccount.set(l.id, acct);
      proj.indexAccountIdentifiers(acct);
    }
  }

  // STEP 4 — Conflict detection (account → multiple customers / customer → multiple accounts)
  const customerToAccts = new Map();   // customerId → Set<account>
  for (const acct of proj.accounts) {
    if (acct.customerIds.size > 1) {
      proj.conflicts.accountClaimingMultipleCustomers.push({
        accountId: acct.projectedId,
        customerIds: [...acct.customerIds],
      });
    }
    for (const cid of acct.customerIds) {
      if (!customerToAccts.has(cid)) customerToAccts.set(cid, new Set());
      customerToAccts.get(cid).add(acct);
    }
  }
  for (const [cid, accts] of customerToAccts.entries()) {
    if (accts.size > 1) {
      proj.conflicts.customerMappedToMultipleAccounts.push({
        customerId: cid,
        accountIds: [...accts].map(a => a.projectedId),
      });
    }
  }

  return proj;
}

// ─── Reporting ─────────────────────────────────────────────────────────────
function tallyProjection(proj) {
  const out = {
    tenant_id: proj.tenantId,
    projected_accounts: proj.accounts.length,
    by_lifecycle: { lead: 0, customer: 0, inactive: 0, churned: 0, prospect: 0 },
    by_seed_source: { sf_customer: 0, sf_lead: 0, lb_lead: 0 },
    customers_attached: 0,
    sf_leads_attached:  0,
    lb_leads_attached:  0,
    identifier_counts:  { phone: 0, email: 0, external_request_id: 0 },
    accounts_with: {
      multiple_lb_leads:          0,
      multiple_sf_leads:          0,
      customer_plus_multiple_lb:  0,
      no_customer_multiple_leads: 0,
      no_customer_no_leads:       0,
    },
    conflicts: {
      same_identifier_during_seed:           proj.conflicts.sameIdentifierMultipleCustomersDuringSeed.length,
      customer_mapped_to_multiple_accounts:  proj.conflicts.customerMappedToMultipleAccounts.length,
      account_claiming_multiple_customers:   proj.conflicts.accountClaimingMultipleCustomers.length,
    },
  };
  for (const a of proj.accounts) {
    out.by_lifecycle[a.lifecycleState] = (out.by_lifecycle[a.lifecycleState] || 0) + 1;
    out.by_seed_source[a.seedSource]   = (out.by_seed_source[a.seedSource]   || 0) + 1;
    out.customers_attached += a.customerIds.size;
    out.sf_leads_attached  += a.sfLeadIds.size;
    out.lb_leads_attached  += a.lbLeadIds.size;
    for (const id of a.identifiers.values()) {
      out.identifier_counts[id.type] = (out.identifier_counts[id.type] || 0) + 1;
    }
    const lb = a.lbLeadIds.size, sfl = a.sfLeadIds.size, cust = a.customerIds.size;
    if (lb >= 2) out.accounts_with.multiple_lb_leads++;
    if (sfl >= 2) out.accounts_with.multiple_sf_leads++;
    if (cust >= 1 && lb >= 2) out.accounts_with.customer_plus_multiple_lb++;
    if (cust === 0 && (lb >= 2 || sfl >= 2)) out.accounts_with.no_customer_multiple_leads++;
    if (cust === 0 && lb === 0 && sfl === 0) out.accounts_with.no_customer_no_leads++;
  }
  return out;
}

// ─── 59-residual re-classification under projected account_id ─────────────
async function reclassifyResiduals(projections) {
  if (!RESIDUALS_PATH || !fs.existsSync(RESIDUALS_PATH)) return null;
  const residuals = JSON.parse(fs.readFileSync(RESIDUALS_PATH, 'utf8'));
  const perLead = residuals.per_lead || [];
  const out = { input: perLead.length, by_action: {}, missing_account_id: 0, rows: [] };

  // Flatten projections: lbLeadId → projection that owns it
  const lbLeadToProj = new Map();
  const lbLeadToAcct = new Map();
  for (const proj of projections) {
    for (const [lid, acct] of proj.lbLeadToAccount.entries()) {
      lbLeadToProj.set(lid, proj);
      lbLeadToAcct.set(lid, acct);
    }
  }

  for (const p of perLead) {
    const acct = lbLeadToAcct.get(p.lb_lead_id);
    if (!acct) { out.missing_account_id++; continue; }
    // Classify under unified-pass rules using projected account state
    const customers = [...acct.customerIds];
    // Pull paid-job count for any customer in the account
    let paidJobs = 0;
    for (const cid of customers) {
      const { data: jobs } = await sf.from('jobs').select('id, status, payment_status').eq('customer_id', cid).limit(50);
      paidJobs += (jobs || []).filter(j => j.status === 'completed' && j.payment_status === 'paid').length;
    }
    const siblingLbCount = acct.lbLeadIds.size - 1;
    const sfLeadsInAcct  = acct.sfLeadIds.size;

    let cat = null;
    if (p.bucket === 'would_link' && (p.action === 'skip_use_apply_path')) {
      cat = paidJobs > 0 ? 'auto_link' : (sfLeadsInAcct > 0 ? 'auto_link' : 'needs_review');
    } else if (p.reason === 'sf_truth_overrides_lost') {
      cat = 'auto_link';
    } else if (p.reason === 'already_reconciled_customer' || p.reason === 'cross_inquiry_or_non_lb_sf_lead') {
      // Account has paying customer OR has a linked sibling → no_match unless recently engaged
      cat = (customers.length > 0 || siblingLbCount > 0) ? 'auto_no_match' : 'needs_review';
    } else {
      cat = 'needs_review';
    }
    out.by_action[cat] = (out.by_action[cat] || 0) + 1;
    out.rows.push({
      lb_lead_id: p.lb_lead_id,
      original_reason: p.reason,
      projected_account: acct.projectedId,
      account_customer_count: customers.length,
      account_paid_jobs: paidJobs,
      account_sibling_lb: siblingLbCount,
      account_sf_leads: sfLeadsInAcct,
      proposed_action: cat,
    });
  }
  return out;
}

// ─── Main ──────────────────────────────────────────────────────────────────
(async () => {
  console.log('Account Layer — Shadow Backfill Report (READ-ONLY)');
  console.log('Generated: ' + nowIso());
  console.log('');

  const { tenants, lbToTenant, unmappedLb } = await discoverTenants();
  const tenantsToRun = TENANT_FILTER && TENANT_FILTER.length > 0
    ? tenants.filter(t => TENANT_FILTER.includes(t))
    : tenants;
  console.log('Discovered tenants: ' + tenants.length);
  console.log('Running for tenants: ' + tenantsToRun.join(', '));
  console.log('Unmapped LB user UUIDs (excluded from LB join): ' + unmappedLb.size);

  // Reverse lbToTenant: tenant_id → [lbUserUuid]
  const tenantToLb = new Map();
  for (const [lbUuid, tid] of lbToTenant.entries()) {
    if (!tenantToLb.has(tid)) tenantToLb.set(tid, []);
    tenantToLb.get(tid).push(lbUuid);
  }

  const projections = [];
  for (const tid of tenantsToRun) {
    const lbUuids = tenantToLb.get(tid) || [];
    const proj = await projectTenant(tid, lbUuids);
    projections.push(proj);
  }

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('PER-TENANT PROJECTION');
  console.log('══════════════════════════════════════════════════════════════════');
  const totals = {
    projected_accounts: 0,
    by_lifecycle: { lead: 0, customer: 0, inactive: 0, churned: 0, prospect: 0 },
    customers_attached: 0,
    sf_leads_attached: 0,
    lb_leads_attached: 0,
    identifier_counts: { phone: 0, email: 0, external_request_id: 0 },
    accounts_with: { multiple_lb_leads: 0, multiple_sf_leads: 0, customer_plus_multiple_lb: 0, no_customer_multiple_leads: 0, no_customer_no_leads: 0 },
    conflicts: { same_identifier_during_seed: 0, customer_mapped_to_multiple_accounts: 0, account_claiming_multiple_customers: 0 },
  };
  for (const proj of projections) {
    const t = tallyProjection(proj);
    console.log('\nTenant ' + t.tenant_id + ':');
    console.log('  projected_accounts:    ' + t.projected_accounts);
    console.log('  by_lifecycle:          customer=' + t.by_lifecycle.customer + '  lead=' + t.by_lifecycle.lead + '  prospect=' + (t.by_lifecycle.prospect || 0) + '  inactive/churned=0');
    console.log('  by_seed_source:        sf_customer=' + t.by_seed_source.sf_customer + '  sf_lead=' + t.by_seed_source.sf_lead + '  lb_lead=' + t.by_seed_source.lb_lead);
    console.log('  customers_attached:    ' + t.customers_attached);
    console.log('  sf_leads_attached:     ' + t.sf_leads_attached);
    console.log('  lb_leads_attached:     ' + t.lb_leads_attached);
    console.log('  identifier_counts:     phone=' + t.identifier_counts.phone + '  email=' + t.identifier_counts.email + '  external_request_id=' + t.identifier_counts.external_request_id);
    console.log('  accounts_with:         multi_lb=' + t.accounts_with.multiple_lb_leads + '  multi_sf=' + t.accounts_with.multiple_sf_leads + '  cust+multiLB=' + t.accounts_with.customer_plus_multiple_lb + '  noCust+multiLeads=' + t.accounts_with.no_customer_multiple_leads + '  empty=' + t.accounts_with.no_customer_no_leads);
    console.log('  conflicts:             same_id_seed=' + t.conflicts.same_identifier_during_seed + '  cust→multi_acct=' + t.conflicts.customer_mapped_to_multiple_accounts + '  acct→multi_cust=' + t.conflicts.account_claiming_multiple_customers);

    totals.projected_accounts += t.projected_accounts;
    for (const k of Object.keys(totals.by_lifecycle))         totals.by_lifecycle[k]         += (t.by_lifecycle[k] || 0);
    totals.customers_attached += t.customers_attached;
    totals.sf_leads_attached  += t.sf_leads_attached;
    totals.lb_leads_attached  += t.lb_leads_attached;
    for (const k of Object.keys(totals.identifier_counts))    totals.identifier_counts[k]    += (t.identifier_counts[k]    || 0);
    for (const k of Object.keys(totals.accounts_with))        totals.accounts_with[k]        += (t.accounts_with[k]        || 0);
    for (const k of Object.keys(totals.conflicts))            totals.conflicts[k]            += (t.conflicts[k]            || 0);
  }

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('TOTALS ACROSS RUN');
  console.log('══════════════════════════════════════════════════════════════════');
  console.log(JSON.stringify(totals, null, 2));

  if (RESIDUALS_PATH) {
    console.log('\n══════════════════════════════════════════════════════════════════');
    console.log('59-RESIDUAL RE-CLASSIFICATION UNDER PROJECTED account_id');
    console.log('══════════════════════════════════════════════════════════════════');
    const r = await reclassifyResiduals(projections);
    if (r) {
      console.log('input rows:           ' + r.input);
      console.log('rows without account: ' + r.missing_account_id);
      console.log('by_action:            ' + JSON.stringify(r.by_action));
      if (OUT_PATH) {
        const conflictDetails = projections.map(p => ({
          tenant_id: p.tenantId,
          same_identifier_during_seed: p.conflicts.sameIdentifierMultipleCustomersDuringSeed,
          customer_mapped_to_multiple_accounts: p.conflicts.customerMappedToMultipleAccounts,
          account_claiming_multiple_customers: p.conflicts.accountClaimingMultipleCustomers,
        }));
        fs.writeFileSync(OUT_PATH, JSON.stringify({ totals, perTenant: projections.map(tallyProjection), conflict_details: conflictDetails, residual_reclass: r }, null, 2));
        console.log('full JSON written to: ' + OUT_PATH);
      }
    }
  } else if (OUT_PATH) {
    const conflictDetails = projections.map(p => ({
      tenant_id: p.tenantId,
      same_identifier_during_seed: p.conflicts.sameIdentifierMultipleCustomersDuringSeed,
      customer_mapped_to_multiple_accounts: p.conflicts.customerMappedToMultipleAccounts,
      account_claiming_multiple_customers: p.conflicts.accountClaimingMultipleCustomers,
    }));
    fs.writeFileSync(OUT_PATH, JSON.stringify({ totals, perTenant: projections.map(tallyProjection), conflict_details: conflictDetails }, null, 2));
    console.log('full JSON written to: ' + OUT_PATH);
  }

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('SAFETY CONFIRMATION');
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  ✓ no DB writes (no INSERT/UPDATE/DELETE issued)');
  console.log('  ✓ no customer messages sent');
  console.log('  ✓ no Lead.status writes');
  console.log('  ✓ no sfJobOutcome writes');
  console.log('  ✓ no attachLbLink invocations');
  console.log('  ✓ apply flags untouched');

  await lb.$disconnect();
})().catch(e => { console.error('FATAL ' + e.message + '\n' + e.stack); lb.$disconnect().finally(() => process.exit(1)); });
