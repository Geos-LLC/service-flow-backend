/**
 * P1.1 (Synchronization Constitution §1.3 / §6.5) — source-account boundary
 * MUST be enforced on every endpoint that returns conversation content to a
 * tenant. The list endpoint, detail endpoint, send endpoint, and media
 * endpoint each provide different views of the same data; gating only some
 * of them is a leak.
 *
 * This is a source-text scan, not an integration test. The actual flag-on
 * behavior is staged-verified per the constitution §11 rollout pattern; this
 * test only asserts the code shape so a future PR can't silently regress.
 *
 * The four endpoints checked (in order they appear in server.js):
 *   - GET  /api/communications/conversations         (list)
 *   - GET  /api/communications/media/:sigcoreMessageId  (media proxy)
 *   - GET  /api/communications/conversations/:id     (detail)
 *   - POST /api/communications/conversations/:id/send (send — all providers)
 */

const fs = require('fs');
const path = require('path');

const SERVER_JS = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

/**
 * Extract the handler body for an endpoint declared at `route`. Returns the
 * literal text from the `app.get/post(...)` line to the next top-level
 * `app.get/post(`. Sufficient for shape assertions.
 */
function extractHandler(routeFragment) {
  const idx = SERVER_JS.indexOf(routeFragment);
  if (idx === -1) throw new Error(`endpoint not found: ${routeFragment}`);
  // Find the next top-level `app.get(` or `app.post(` (with no indentation)
  const tail = SERVER_JS.slice(idx + routeFragment.length);
  const nextMatch = tail.search(/\napp\.(get|post)\(['"]/);
  return SERVER_JS.slice(idx, idx + routeFragment.length + (nextMatch === -1 ? 5000 : nextMatch));
}

describe('Source-account boundary on content endpoints (Constitution §1.3 / §6.5)', () => {

  describe('GET /api/communications/conversations (list)', () => {
    const block = extractHandler("app.get('/api/communications/conversations',");

    test('uses loadDisconnectedAccountIds + filterVisibleConversations', () => {
      expect(block).toMatch(/loadDisconnectedAccountIds|filterVisibleConversations/);
    });

    test('gates on SOURCE_ACCOUNT_BOUNDARY_ENFORCED', () => {
      expect(block).toMatch(/SOURCE_ACCOUNT_BOUNDARY_ENFORCED/);
    });
  });

  describe('GET /api/communications/conversations/:id (detail)', () => {
    const block = extractHandler("app.get('/api/communications/conversations/:id',");

    test('gates on SOURCE_ACCOUNT_BOUNDARY_ENFORCED before returning content', () => {
      expect(block).toMatch(/SOURCE_ACCOUNT_BOUNDARY_ENFORCED/);
    });

    test('reads provider_account_id status via getProviderAccountStatus', () => {
      expect(block).toMatch(/getProviderAccountStatus\s*\(\s*supabase\s*,\s*conv\.provider_account_id/);
    });

    test('returns 404 (not 403) on disconnected account — matches list visibility', () => {
      expect(block).toMatch(/status\s*\(\s*404\s*\)/);
      // The boundary block specifically uses 404. Look for it inside the boundary check.
      const m = block.match(/SOURCE_ACCOUNT_BOUNDARY_ENFORCED[\s\S]{0,500}?status\(\s*(\d+)\s*\)/);
      expect(m).not.toBeNull();
      expect(m[1]).toBe('404');
    });

    test('boundary check fires BEFORE the message fetch (no side-channel leak)', () => {
      const boundaryIdx = block.indexOf('SOURCE_ACCOUNT_BOUNDARY_ENFORCED');
      const fetchIdx = block.indexOf("from('communication_messages')");
      expect(boundaryIdx).toBeGreaterThan(0);
      expect(fetchIdx).toBeGreaterThan(boundaryIdx);
    });
  });

  describe('POST /api/communications/conversations/:id/send (send — all providers)', () => {
    const block = extractHandler("app.post('/api/communications/conversations/:id/send',");

    test('gates on SOURCE_ACCOUNT_BOUNDARY_ENFORCED at the top of the handler', () => {
      expect(block).toMatch(/SOURCE_ACCOUNT_BOUNDARY_ENFORCED/);
    });

    test('returns 409 with source_account_disconnected reason (machine-readable contract)', () => {
      expect(block).toMatch(/status\(\s*409\s*\)[\s\S]{0,200}source_account_disconnected/);
    });

    test('boundary check fires BEFORE any provider-specific routing (LB / WhatsApp / OpenPhone)', () => {
      const boundaryIdx = block.indexOf('SOURCE_ACCOUNT_BOUNDARY_ENFORCED');
      // First provider branch is always reached AFTER the top-level boundary check.
      const firstProviderIdx = Math.min(
        ...['leadbridge', 'whatsapp', 'sigcoreRequest'].map(needle => {
          const i = block.indexOf(needle);
          return i === -1 ? Infinity : i;
        })
      );
      expect(boundaryIdx).toBeGreaterThan(0);
      expect(firstProviderIdx).toBeGreaterThan(boundaryIdx);
    });

    test('WhatsApp send branch does NOT bypass boundary (no separate code path)', () => {
      // The unified handler at the top of /send ensures all providers
      // including WhatsApp are gated by the same top-level check. The
      // WhatsApp branch (provider === 'whatsapp') doesn't re-fetch
      // conv.provider_account_id from a different source.
      expect(block).toMatch(/conv\.provider\s*===\s*['"]whatsapp['"]/);
      // And the WhatsApp branch's send doesn't access a different conv var.
      const waBranchIdx = block.indexOf("conv.provider === 'whatsapp'");
      const reFetchIdx = block.indexOf('from(\'communication_conversations\')', waBranchIdx);
      // No re-fetch of conv inside the WA branch (would indicate a bypass)
      // — re-fetch may happen for update at the end but that's fine.
      // If it did re-fetch with .select(*) and replaced `conv`, the boundary
      // would be stale. We just assert no `const conv = ...` reassignment
      // happens after the boundary check.
      const reassignment = block.slice(block.indexOf('SOURCE_ACCOUNT_BOUNDARY_ENFORCED'))
        .match(/\b(const|let|var)\s+conv\s*=/);
      expect(reassignment).toBeNull();
    });
  });

  describe('GET /api/communications/media/:sigcoreMessageId (media proxy)', () => {
    const block = extractHandler("app.get('/api/communications/media/:sigcoreMessageId',");

    test('gates on SOURCE_ACCOUNT_BOUNDARY_ENFORCED before streaming bytes', () => {
      expect(block).toMatch(/SOURCE_ACCOUNT_BOUNDARY_ENFORCED/);
    });

    test('reads provider_account_id from conversation lookup', () => {
      // The conversation SELECT must include provider_account_id so the
      // boundary check has data to work with.
      expect(block).toMatch(/select\(['"][^'"]*provider_account_id/);
    });

    test('returns 404 on disconnected (mirrors detail; mustn\'t reveal that the message exists)', () => {
      const m = block.match(/SOURCE_ACCOUNT_BOUNDARY_ENFORCED[\s\S]{0,500}?status\(\s*(\d+)\s*\)/);
      expect(m).not.toBeNull();
      expect(m[1]).toBe('404');
    });

    test('boundary check fires BEFORE the upstream Sigcore fetch (no side-channel)', () => {
      const boundaryIdx = block.indexOf('SOURCE_ACCOUNT_BOUNDARY_ENFORCED');
      const upstreamIdx = block.indexOf("axios(");
      expect(boundaryIdx).toBeGreaterThan(0);
      expect(upstreamIdx).toBeGreaterThan(boundaryIdx);
    });

    test('boundary check fires AFTER the ownership check (user_id !== userId still 404s first)', () => {
      const ownershipIdx = block.indexOf('conv.user_id !== userId');
      const boundaryIdx = block.indexOf('SOURCE_ACCOUNT_BOUNDARY_ENFORCED');
      expect(ownershipIdx).toBeGreaterThan(0);
      expect(boundaryIdx).toBeGreaterThan(ownershipIdx);
    });
  });

  describe('Coverage — every content endpoint is accounted for', () => {
    // If a NEW content-returning endpoint is added under /api/communications/,
    // this test catches it. Update the expected set when adding endpoints,
    // and add a boundary check to the new endpoint at the same time.
    const KNOWN_CONTENT_ENDPOINTS = new Set([
      "app.get('/api/communications/conversations',",
      "app.get('/api/communications/conversations/:id',",
      "app.post('/api/communications/conversations/:id/send',",
      "app.get('/api/communications/media/:sigcoreMessageId',",
    ]);

    // Endpoints under /api/communications that are NOT content-returning
    // (status, config, connect, sync, etc.) — explicitly listed so we know
    // we considered them.
    const KNOWN_NON_CONTENT_ENDPOINTS = new Set([
      "app.post('/api/communications/connect-openphone',",
      "app.get('/api/communications/status',",
      "app.get('/api/communications/phone-numbers',",
      "app.post('/api/communications/webhooks/sigcore',",
      "app.post('/api/communications/sync',",
      "app.get('/api/communications/sync/progress',",
      "app.post('/api/communications/sync/cancel',",
      "app.post('/api/communications/relink',",
      "app.get('/api/communications/provider-accounts',",
      "app.get('/api/communications/location-mappings',",
      "app.post('/api/communications/location-mappings',",
    ]);

    test('all /api/communications endpoints are classified as content OR non-content', () => {
      const regex = /app\.(get|post)\(['"]\/api\/communications[^'"]*['"]/g;
      const matches = [...SERVER_JS.matchAll(regex)].map(m => m[0] + ',');
      const unknown = matches.filter(m =>
        !KNOWN_CONTENT_ENDPOINTS.has(m) &&
        !KNOWN_NON_CONTENT_ENDPOINTS.has(m)
      );
      if (unknown.length > 0) {
        throw new Error(
          `Unknown /api/communications endpoint(s) detected:\n${unknown.join('\n')}\n\n`
          + 'If it returns conversation content, add SOURCE_ACCOUNT_BOUNDARY_ENFORCED gating '
          + 'and add the route to KNOWN_CONTENT_ENDPOINTS in this test.\n'
          + 'If it does not return content, add it to KNOWN_NON_CONTENT_ENDPOINTS and explain why.'
        );
      }
      expect(unknown).toEqual([]);
    });

    test('every content endpoint contains the boundary check string', () => {
      for (const route of KNOWN_CONTENT_ENDPOINTS) {
        const block = extractHandler(route);
        if (!/SOURCE_ACCOUNT_BOUNDARY_ENFORCED/.test(block)) {
          throw new Error(`Content endpoint ${route} is missing SOURCE_ACCOUNT_BOUNDARY_ENFORCED gating.`);
        }
      }
    });
  });
});
