'use strict';

/**
 * LeadBridge status sync — regression guard for the two-field attribution
 * migration (050). Spec requires:
 *
 *   "Status sync to LB MUST use stable identifiers:
 *      - leadbridge_contact_id / external lead id
 *      - external_business_id
 *      - provider account id
 *      - channel
 *    source_raw only as fallback / debug. NOT source text."
 *
 * The lead-status webhook handler in leadbridge-service.js currently joins
 * jobs ← external_lead_id + user_id + channel. The two-field migration
 * introduces a `leads.source` field that becomes the canonical (mapped)
 * value, and `leads.source_raw` that holds the raw provider label.
 *
 * If a future change ever introduces a query that matches LB events to SF
 * jobs/leads by `source` text (e.g. someone "fixes" attribution by joining
 * on source name) it will silently break under tenant remappings: change a
 * mapping → all historical status events stop matching. These tests are
 * source-scan guards that fail loud when that mistake creeps in.
 */

const fs = require('fs');
const path = require('path');

const LB_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'leadbridge-service.js'),
  'utf8',
);

describe('LB status-sync regression — stable identifiers only', () => {
  test('lead-status handler matches jobs by lb_external_request_id, NOT by leads.source', () => {
    // Anchor on the job-lookup block specifically (skips past the HMAC decrypt
    // block which also contains [LB Lead-Status] log lines).
    const at = LB_SRC.indexOf('Locate the linked SF job');
    expect(at).toBeGreaterThan(-1);

    // Window covers the entire job-lookup + status-write block.
    const window = LB_SRC.slice(at, at + 2000);

    // Required: the lookup key.
    expect(window).toMatch(/\.eq\(['"]lb_external_request_id['"]/);
    // Required: tenant scoping.
    expect(window).toMatch(/\.eq\(['"]user_id['"]/);
    // Required: channel disambiguation (when present).
    expect(window).toMatch(/lb_channel|\bchannel\b/);

    // Forbidden: any join/match against leads.source or leads.source_raw
    // from inside the status-sync handler. Mapping changes must NOT affect
    // status delivery.
    expect(window).not.toMatch(/\.from\(['"]leads['"]\)[\s\S]{0,400}\.eq\(['"]source/);
    expect(window).not.toMatch(/\.eq\(['"]source['"]\s*,/);
    expect(window).not.toMatch(/\.eq\(['"]source_raw['"]\s*,/);
  });

  test('outbound job-status push also keys on external ids (channel + lb_external_request_id)', () => {
    // SF → LB outbound path lives elsewhere (lb-outbound-*), but the
    // /service-flow/job-status path string is built here. Make sure no code
    // path in this file constructs the outbound payload from leads.source.
    expect(LB_SRC).toContain('LB_SF_INBOUND_PATH'); // sanity
    // Forbidden: outbound payload key that includes the literal source string.
    expect(LB_SRC).not.toMatch(/source:\s*lead\.source[\s,}]/);
    expect(LB_SRC).not.toMatch(/sourceName:\s*lead\.source[\s,}]/);
  });
});

describe('LB two-field source attribution — migration 050 helpers wired through', () => {
  test('runLbSync loads tenant LB mappings once before the per-account loop', () => {
    expect(LB_SRC).toMatch(/loadSourceMappings\(\s*supabase\s*,\s*userId\s*,\s*['"]leadbridge['"]/);
  });

  test('per-account inputs to resolveOrCreateLead and the engine include sourceMappingsLookup', () => {
    const sites = LB_SRC.match(/sourceMappingsLookup/g) || [];
    // 2 in runLbSync (engine + legacy), 2 in webhook handler (engine + legacy),
    // plus 1 import, plus a few inside lib usage references — comfortably > 5.
    expect(sites.length).toBeGreaterThanOrEqual(5);
  });

  test('createLeadFromLB persists both leads.source AND leads.source_raw', () => {
    // The insert call site for the canonical lead create.
    const at = LB_SRC.indexOf('async function createLeadFromLB');
    expect(at).toBeGreaterThan(-1);
    const window = LB_SRC.slice(at, at + 3500);
    expect(window).toMatch(/pickLBSources\(\{[\s\S]{0,200}sourceMappingsLookup/);
    expect(window).toMatch(/\bsource\b\s*,/);
    expect(window).toMatch(/\bsource_raw\b\s*,/);
  });

  test('createChildLeadFromLB persists both leads.source AND leads.source_raw', () => {
    const at = LB_SRC.indexOf('async function createChildLeadFromLB');
    expect(at).toBeGreaterThan(-1);
    const window = LB_SRC.slice(at, at + 3500);
    expect(window).toMatch(/pickLBSources\(\{[\s\S]{0,200}sourceMappingsLookup/);
    expect(window).toMatch(/\bsource\b\s*,/);
    expect(window).toMatch(/\bsource_raw\b\s*,/);
  });

  test('enrichLeadFromLB selects source_raw so buildEnrichLeadPatch can detect missing field', () => {
    const at = LB_SRC.indexOf('async function enrichLeadFromLB');
    expect(at).toBeGreaterThan(-1);
    const window = LB_SRC.slice(at, at + 600);
    expect(window).toMatch(/\.select\(['"][^'"]*source_raw[^'"]*['"]\)/);
  });
});
