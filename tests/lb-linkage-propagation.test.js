/**
 * LB linkage propagation — unit tests.
 *
 * Covers the new identity chain introduced in migration 051:
 *
 *   LB lead → SF lead.lb_*  (createLeadFromLB, createChildLeadFromLB)
 *   SF lead.lb_* → SF job.lb_*  (resolveLbLinkageForNewJob in /api/jobs)
 *   enrichLeadFromLB fill-nulls-only semantics
 *
 * No live Supabase. The supabase double is the same minimal one used by
 * leadbridge-outbound.test.js, extended with the columns we now read.
 */

const {
  pickLbLink,
  lbLinkMatches,
  buildEnrichLeadPatch,
} = require('../lib/lb-ingestion');
const { resolveLbLinkageForNewJob } = require('../lib/lb-job-linkage');
const { classify } = require('../scripts/backfill-jobs-lb-linkage');

// ──────────────────────────────────────────────────────────────────
// pickLbLink — pure helper
// ──────────────────────────────────────────────────────────────────
describe('pickLbLink', () => {
  test('extracts all four fields from an explicit input', () => {
    expect(pickLbLink({
      lbExternalRequestId: 'EXT-1',
      lbChannel: 'thumbtack',
      lbBusinessId: 'biz-9',
      lbProviderAccountId: 42,
    })).toEqual({
      lb_external_request_id: 'EXT-1',
      lb_channel: 'thumbtack',
      lb_business_id: 'biz-9',
      lb_provider_account_id: 42,
    });
  });

  test('falls back to input.channel when lbChannel is omitted', () => {
    expect(pickLbLink({ lbExternalRequestId: 'EXT-2', channel: 'yelp' })).toEqual({
      lb_external_request_id: 'EXT-2',
      lb_channel: 'yelp',
      lb_business_id: null,
      lb_provider_account_id: null,
    });
  });

  test('coerces non-string ids to strings, numeric account id to number', () => {
    expect(pickLbLink({ lbExternalRequestId: 12345, lbChannel: 'thumbtack', lbBusinessId: 678, lbProviderAccountId: '999' })).toEqual({
      lb_external_request_id: '12345',
      lb_channel: 'thumbtack',
      lb_business_id: '678',
      lb_provider_account_id: 999,
    });
  });

  test('returns all-nulls on empty / undefined input', () => {
    expect(pickLbLink(undefined)).toEqual({
      lb_external_request_id: null, lb_channel: null, lb_business_id: null, lb_provider_account_id: null,
    });
    expect(pickLbLink({})).toEqual({
      lb_external_request_id: null, lb_channel: null, lb_business_id: null, lb_provider_account_id: null,
    });
  });

  test('non-finite numeric provider_account_id becomes null', () => {
    expect(pickLbLink({ lbProviderAccountId: 'abc' }).lb_provider_account_id).toBeNull();
    expect(pickLbLink({ lbProviderAccountId: NaN }).lb_provider_account_id).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// lbLinkMatches — fast equality test
// ──────────────────────────────────────────────────────────────────
describe('lbLinkMatches', () => {
  test('true when all four columns equal (string + numeric coercion)', () => {
    expect(lbLinkMatches(
      { lb_external_request_id: '1', lb_channel: 'thumbtack', lb_business_id: 'b', lb_provider_account_id: 7 },
      { lb_external_request_id: '1', lb_channel: 'thumbtack', lb_business_id: 'b', lb_provider_account_id: '7' },
    )).toBe(true);
  });
  test('false when external_request_id differs', () => {
    expect(lbLinkMatches(
      { lb_external_request_id: '1', lb_channel: 'thumbtack' },
      { lb_external_request_id: '2', lb_channel: 'thumbtack' },
    )).toBe(false);
  });
  test('null vs undefined treated as equal', () => {
    expect(lbLinkMatches(
      { lb_external_request_id: null, lb_channel: null, lb_business_id: null, lb_provider_account_id: null },
      { lb_external_request_id: undefined, lb_channel: undefined, lb_business_id: undefined, lb_provider_account_id: undefined },
    )).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────
// buildEnrichLeadPatch — fill-nulls-only for lb_*
// ──────────────────────────────────────────────────────────────────
describe('buildEnrichLeadPatch — LB linkage semantics', () => {
  test('fills lb_* when existing row has all-null linkage', () => {
    const patch = buildEnrichLeadPatch({
      existing: { source: 'X (thumbtack)', source_raw: 'X (thumbtack)', email: null,
        lb_external_request_id: null, lb_channel: null, lb_business_id: null, lb_provider_account_id: null },
      input: { accountDisplayName: 'X', channel: 'thumbtack',
        lbExternalRequestId: 'EXT-1', lbChannel: 'thumbtack', lbBusinessId: 'BIZ-9', lbProviderAccountId: 7 },
    });
    expect(patch).toBeTruthy();
    expect(patch.lb_external_request_id).toBe('EXT-1');
    expect(patch.lb_channel).toBe('thumbtack');
    expect(patch.lb_business_id).toBe('BIZ-9');
    expect(patch.lb_provider_account_id).toBe(7);
  });

  test('does NOT overwrite an existing non-null lb_external_request_id with a different value', () => {
    const patch = buildEnrichLeadPatch({
      existing: { source: 'X (thumbtack)', source_raw: 'X (thumbtack)',
        lb_external_request_id: 'OLD', lb_channel: 'thumbtack' },
      input: { accountDisplayName: 'X', channel: 'thumbtack',
        lbExternalRequestId: 'NEW', lbChannel: 'thumbtack' },
    });
    // patch may be null (nothing to update) or, if other fields trigger,
    // it must not contain lb_external_request_id or lb_channel.
    if (patch) {
      expect(patch).not.toHaveProperty('lb_external_request_id');
      expect(patch).not.toHaveProperty('lb_channel');
    }
  });

  test('returns null when nothing needs updating (idempotent)', () => {
    const patch = buildEnrichLeadPatch({
      existing: { source: 'X (thumbtack)', source_raw: 'X (thumbtack)', email: 'a@b.c',
        lb_external_request_id: 'EXT', lb_channel: 'thumbtack' },
      input: { accountDisplayName: 'X', channel: 'thumbtack',
        lbExternalRequestId: 'EXT', lbChannel: 'thumbtack', customerEmail: 'a@b.c' },
    });
    expect(patch).toBeNull();
  });

  test('partial fill — adds lb_channel when only that is missing, leaves existing external_request_id alone', () => {
    const patch = buildEnrichLeadPatch({
      existing: { source: 'X (thumbtack)', source_raw: 'X (thumbtack)',
        lb_external_request_id: 'EXT', lb_channel: null },
      input: { accountDisplayName: 'X', channel: 'thumbtack',
        lbExternalRequestId: 'EXT', lbChannel: 'thumbtack' },
    });
    expect(patch).toBeTruthy();
    expect(patch.lb_channel).toBe('thumbtack');
    expect(patch).not.toHaveProperty('lb_external_request_id');
  });
});

// ──────────────────────────────────────────────────────────────────
// Supabase double for resolveLbLinkageForNewJob.
// ──────────────────────────────────────────────────────────────────
function makeSupabaseStub({ leads = [] } = {}) {
  return {
    from(table) {
      const filter = {};
      const inFilter = {};
      const chain = {
        select() { return chain; },
        eq(k, v) { filter[k] = v; return chain; },
        in(k, vs) { inFilter[k] = vs; return chain; },
        limit() { return chain; },
        then(resolve) {
          let rows = leads.filter(r => Object.entries(filter).every(([k, v]) => String(r[k]) === String(v)));
          for (const [k, vs] of Object.entries(inFilter)) {
            rows = rows.filter(r => vs.map(String).includes(String(r[k])));
          }
          resolve({ data: rows, error: null });
        },
      };
      return chain;
    },
  };
}

// ──────────────────────────────────────────────────────────────────
// resolveLbLinkageForNewJob — lead → job propagation gate
// ──────────────────────────────────────────────────────────────────
describe('resolveLbLinkageForNewJob', () => {
  test('explicit linkage wins, no lead lookup', async () => {
    const supabase = makeSupabaseStub();
    const out = await resolveLbLinkageForNewJob(supabase, {
      userId: 2,
      customerId: 100,
      explicit: { lb_external_request_id: 'EXT-X', lb_channel: 'yelp', lb_business_id: 'BZ', lb_provider_account_id: 11 },
    });
    expect(out.reason).toBe('explicit');
    expect(out.link.lb_external_request_id).toBe('EXT-X');
    expect(out.link.lb_channel).toBe('yelp');
    expect(out.link.lb_business_id).toBe('BZ');
    expect(out.link.lb_provider_account_id).toBe(11);
  });

  test('explicit lb_channel outside {thumbtack,yelp} dropped to null', async () => {
    const out = await resolveLbLinkageForNewJob(makeSupabaseStub(), {
      userId: 2, customerId: 100,
      explicit: { lb_external_request_id: 'X', lb_channel: 'rogue' },
      logger: { warn: () => {} },
    });
    expect(out.reason).toBe('explicit');
    expect(out.link.lb_channel).toBeNull();
  });

  test('lead match → propagates linkage', async () => {
    const supabase = makeSupabaseStub({
      leads: [{ id: 5, user_id: 2, converted_customer_id: 100,
        lb_external_request_id: 'EXT-7', lb_channel: 'thumbtack', lb_business_id: 'BIZ-1', lb_provider_account_id: 33 }],
    });
    const out = await resolveLbLinkageForNewJob(supabase, { userId: 2, customerId: 100 });
    expect(out.reason).toBe('lead_match');
    expect(out.leadId).toBe(5);
    expect(out.link.lb_external_request_id).toBe('EXT-7');
    expect(out.link.lb_channel).toBe('thumbtack');
  });

  test('no customer → no_customer reason', async () => {
    const out = await resolveLbLinkageForNewJob(makeSupabaseStub(), { userId: 2, customerId: null });
    expect(out.reason).toBe('no_customer');
    expect(out.link.lb_external_request_id).toBeNull();
  });

  test('customer has no lead → no_lead', async () => {
    const out = await resolveLbLinkageForNewJob(makeSupabaseStub({ leads: [] }), { userId: 2, customerId: 100 });
    expect(out.reason).toBe('no_lead');
  });

  test('lead exists but has no LB linkage → lead_unlinked', async () => {
    const supabase = makeSupabaseStub({
      leads: [{ id: 5, user_id: 2, converted_customer_id: 100, lb_external_request_id: null, lb_channel: null }],
    });
    const out = await resolveLbLinkageForNewJob(supabase, { userId: 2, customerId: 100 });
    expect(out.reason).toBe('lead_unlinked');
    expect(out.link.lb_external_request_id).toBeNull();
  });

  test('two LB-linked leads with DIFFERENT external ids → ambiguous, returns nulls', async () => {
    const supabase = makeSupabaseStub({
      leads: [
        { id: 5, user_id: 2, converted_customer_id: 100, lb_external_request_id: 'A', lb_channel: 'thumbtack' },
        { id: 6, user_id: 2, converted_customer_id: 100, lb_external_request_id: 'B', lb_channel: 'thumbtack' },
      ],
    });
    const warn = jest.fn();
    const out = await resolveLbLinkageForNewJob(supabase, { userId: 2, customerId: 100, logger: { warn } });
    expect(out.reason).toBe('ambiguous_leads');
    expect(out.link.lb_external_request_id).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ambiguous_leads'));
  });

  test('two leads agree on same external id → treated as single match', async () => {
    const supabase = makeSupabaseStub({
      leads: [
        { id: 5, user_id: 2, converted_customer_id: 100, lb_external_request_id: 'SAME', lb_channel: 'thumbtack' },
        { id: 6, user_id: 2, converted_customer_id: 100, lb_external_request_id: 'SAME', lb_channel: 'thumbtack' },
      ],
    });
    const out = await resolveLbLinkageForNewJob(supabase, { userId: 2, customerId: 100 });
    expect(out.reason).toBe('lead_match');
    expect(out.link.lb_external_request_id).toBe('SAME');
  });

  test('cross-tenant — another tenant\'s lead never leaks', async () => {
    const supabase = makeSupabaseStub({
      leads: [
        // Tenant 9's lead — has same customer_id by coincidence
        { id: 7, user_id: 9, converted_customer_id: 100, lb_external_request_id: 'CROSS', lb_channel: 'yelp' },
        // Tenant 2's lead — no LB linkage
        { id: 5, user_id: 2, converted_customer_id: 100, lb_external_request_id: null, lb_channel: null },
      ],
    });
    const out = await resolveLbLinkageForNewJob(supabase, { userId: 2, customerId: 100 });
    expect(out.reason).toBe('lead_unlinked');
    expect(out.link.lb_external_request_id).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// Backfill classifier — pure function on the dry-run path
// ──────────────────────────────────────────────────────────────────
describe('backfill classify()', () => {
  const job = { id: 1, user_id: 2, customer_id: 100, status: 'completed', created_at: '2026-01-01' };

  test('HIGH — single LB-linked lead + identity agrees', () => {
    const lead = { id: 5, lb_external_request_id: 'EXT-7', lb_channel: 'thumbtack', lb_business_id: null, lb_provider_account_id: null };
    const identity = { sf_lead_id: 5, sf_customer_id: 100 };
    const c = classify(job, [lead], identity);
    expect(c.tier).toBe('HIGH');
    expect(c.leadId).toBe(5);
    expect(c.link.lb_external_request_id).toBe('EXT-7');
  });

  test('MEDIUM — single LB-linked lead, no identity record', () => {
    const lead = { id: 5, lb_external_request_id: 'EXT', lb_channel: 'thumbtack' };
    const c = classify(job, [lead], null);
    expect(c.tier).toBe('MEDIUM');
  });

  test('MANUAL_REVIEW — identity disagrees with lead', () => {
    const lead = { id: 5, lb_external_request_id: 'EXT', lb_channel: 'thumbtack' };
    const identity = { sf_lead_id: 999, sf_customer_id: 100 };
    const c = classify(job, [lead], identity);
    expect(c.tier).toBe('MANUAL_REVIEW');
  });

  test('AMBIGUOUS — multiple distinct LB-linked leads', () => {
    const c = classify(job, [
      { id: 5, lb_external_request_id: 'A', lb_channel: 'thumbtack' },
      { id: 6, lb_external_request_id: 'B', lb_channel: 'thumbtack' },
    ], null);
    expect(c.tier).toBe('AMBIGUOUS');
    expect(c.candidates).toHaveLength(2);
    expect(c.link).toBeNull();
  });

  test('MISSING — no lead', () => {
    expect(classify(job, [], null).tier).toBe('MISSING');
    expect(classify(job, [], null).reason).toBe('no_lead');
  });

  test('MISSING — lead exists but unlinked', () => {
    const c = classify(job, [{ id: 5, lb_external_request_id: null }], null);
    expect(c.tier).toBe('MISSING');
    expect(c.reason).toBe('lead_unlinked');
  });

  test('MISSING — no customer_id on job', () => {
    expect(classify({ ...job, customer_id: null }, [], null).tier).toBe('MISSING');
  });
});
