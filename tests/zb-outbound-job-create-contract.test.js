/**
 * Golden-fixture contract test — `POST /v1/jobs` request body shape.
 *
 * This test pins the producer output against the EXACT shape that ZB
 * accepted with a 201 response during direct controlled discovery on
 * 2026-05-19. See docs/architecture/job-create-contract-discovery.md
 * for the evidence chain (Tier-A live evidence per §1.1 + §1.2).
 *
 * WHY THIS TEST EXISTS (lesson from the 2026-05-19 incidents):
 *
 *   Tests that mirror the producer's OWN assumptions are not regression
 *   tests — they are tautologies. The first live POST failed because
 *   the producer-side test asserted `timeslot.start_time` matched the
 *   producer's `timeslot.start_time` emission; both were wrong, the
 *   test passed, ZB rejected.
 *
 *   This contract test references an EXTERNAL authority — the verified
 *   shape captured from a real ZB 2xx response. If the producer drifts
 *   away from that shape, this test fails BEFORE the next live POST.
 *
 * MAINTENANCE RULE:
 *
 *   Do NOT update VERIFIED_* constants below to chase a producer
 *   change. They reflect what ZB ACCEPTED in production, captured at a
 *   specific point in time. Changes require:
 *     (a) a new live discovery that proves ZB now accepts a different
 *         shape, OR
 *     (b) explicit ZB support confirmation that a field has been
 *         renamed/added/removed.
 *   Either way, link the evidence in the contract file and update the
 *   "Tier-A verified on YYYY-MM-DD" date below.
 */

const { buildZbBody } = require('../lib/zb-outbound-producer');

// Tier-A verified 2026-05-19 — two consecutive `201 Created` responses
// against pilot tenant ZB API; full discovery transcript in
// docs/architecture/job-create-contract-discovery.md §1.
// 2026-05-20: added sms_notifications + email_notifications to suppress
// ZB's native notification system per SF-owns-notifications design
// (see zb-outbound-command-confirmation.md §1.F).
const VERIFIED_TOP_LEVEL_KEYS = [
  'territory_id',
  'customer_id',
  'services',
  'timeslot',
  'address',
  'assigned_providers',
  'assignment_method',
  'duration',
  'sms_notifications',
  'email_notifications',
];

const VERIFIED_ADDRESS_SUB_KEYS = [
  'line1',
  'city',
  'state',
  'postal_code',
  'country',
];

const VERIFIED_TIMESLOT_SUB_KEYS = ['type', 'start'];

const VERIFIED_SERVICE_ITEM_KEY = 'service_id';

const VERIFIED_ASSIGNMENT_METHOD = 'auto';

const VERIFIED_TIMESLOT_TYPE = 'specific_time';

// ────────────────────────────────────────────────────────────────────
// Fixtures match the shape of inputs the producer sees in production.
// ────────────────────────────────────────────────────────────────────

const baseSfJob = {
  id: 99001,
  user_id: 2,
  scheduled_date: '2026-12-15 03:00:00',
  duration: 120,
  service_address_street: '1372 6th Street Northwest',
  service_address_city: 'Winter Haven',
  service_address_state: 'Florida',
  service_address_zip: '33881',
  service_address_country: 'USA',
};

const linkage = {
  customer_zb_id: '1778631371601x663847643950088200',
  service_zb_id: '1733515994541x539673354374156300',
  territory_zb_id: '1774549605695x331883119954100200',
  team_member_zb_ids: ['1733415450171x961236852912174200'],
  sf_address: {
    line1: '1372 6th Street Northwest',
    city: 'Winter Haven',
    state: 'Florida',
    postal_code: '33881',
    country: 'USA',
  },
};

// ────────────────────────────────────────────────────────────────────

describe('job.create body — Tier-A verified shape (2026-05-19)', () => {
  test('top-level keys match the verified set', () => {
    const body = buildZbBody(baseSfJob, linkage);
    expect(Object.keys(body).sort()).toEqual([...VERIFIED_TOP_LEVEL_KEYS].sort());
  });

  test('top-level body contains no SF-style aliases', () => {
    const body = buildZbBody(baseSfJob, linkage);
    expect(body).not.toHaveProperty('start_time');
    expect(body).not.toHaveProperty('scheduled_date');
    expect(body).not.toHaveProperty('service_date');
    expect(body).not.toHaveProperty('notes');
  });

  test('address has exactly the 5 verified sub-keys', () => {
    const body = buildZbBody(baseSfJob, linkage);
    expect(Object.keys(body.address).sort()).toEqual([...VERIFIED_ADDRESS_SUB_KEYS].sort());
  });

  test('address.country is present (regression guard for 2026-05-19 second incident)', () => {
    const body = buildZbBody(baseSfJob, linkage);
    expect(body.address.country).toBe('USA');
  });

  test('timeslot has exactly the 2 verified sub-keys', () => {
    const body = buildZbBody(baseSfJob, linkage);
    expect(Object.keys(body.timeslot).sort()).toEqual([...VERIFIED_TIMESLOT_SUB_KEYS].sort());
  });

  test('timeslot.type is exactly the verified enum value', () => {
    const body = buildZbBody(baseSfJob, linkage);
    expect(body.timeslot.type).toBe(VERIFIED_TIMESLOT_TYPE);
  });

  test('timeslot.start is ISO 8601 with Z suffix (regression guard for 2026-05-19 first incident)', () => {
    const body = buildZbBody(baseSfJob, linkage);
    expect(body.timeslot.start).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(body.timeslot).not.toHaveProperty('start_time');
  });

  test('services array element uses the verified inner key', () => {
    const body = buildZbBody(baseSfJob, linkage);
    expect(body.services).toHaveLength(1);
    expect(Object.keys(body.services[0])).toEqual([VERIFIED_SERVICE_ITEM_KEY]);
    expect(body.services[0][VERIFIED_SERVICE_ITEM_KEY]).toBe(linkage.service_zb_id);
  });

  test('assignment_method matches verified value when providers present', () => {
    const body = buildZbBody(baseSfJob, linkage);
    expect(body.assignment_method).toBe(VERIFIED_ASSIGNMENT_METHOD);
    expect(body.assigned_providers).toEqual(linkage.team_member_zb_ids);
  });

  test('duration emitted as a Number (not string)', () => {
    const body = buildZbBody(baseSfJob, linkage);
    expect(typeof body.duration).toBe('number');
    expect(body.duration).toBe(120);
  });

  test('full body deep-equals the verified 2026-05-19 shape (+ notification suppression flags 2026-05-20)', () => {
    const body = buildZbBody(baseSfJob, linkage);
    expect(body).toEqual({
      territory_id: '1774549605695x331883119954100200',
      customer_id: '1778631371601x663847643950088200',
      services: [{ service_id: '1733515994541x539673354374156300' }],
      timeslot: { type: 'specific_time', start: '2026-12-15T03:00:00Z' },
      address: {
        line1: '1372 6th Street Northwest',
        city: 'Winter Haven',
        state: 'Florida',
        postal_code: '33881',
        country: 'USA',
      },
      assigned_providers: ['1733415450171x961236852912174200'],
      assignment_method: 'auto',
      duration: 120,
      sms_notifications: false,
      email_notifications: false,
    });
  });

  // Regression guards added 2026-05-20 after incident:
  // ZB sent its native provider-notification SMS using the customer-greeting
  // template to the team member's phone. SF owns notifications for
  // SF-originated jobs; ZB notifications must be explicitly suppressed.
  test('producer emits sms_notifications=false (SF owns SMS, ZB suppressed)', () => {
    const body = buildZbBody(baseSfJob, linkage);
    expect(body.sms_notifications).toBe(false);
  });

  test('producer emits email_notifications=false (SF owns email, ZB suppressed)', () => {
    const body = buildZbBody(baseSfJob, linkage);
    expect(body.email_notifications).toBe(false);
  });

  test('notification suppression is explicit boolean false (not undefined / not null)', () => {
    const body = buildZbBody(baseSfJob, linkage);
    expect(body).toHaveProperty('sms_notifications');
    expect(body).toHaveProperty('email_notifications');
    expect(typeof body.sms_notifications).toBe('boolean');
    expect(typeof body.email_notifications).toBe('boolean');
    // Explicit false beats omitted-and-defaulted-by-ZB; the suppression must be
    // wire-visible so ZB cannot fall back to tenant-level notification settings.
  });

  test('assigned_providers + assignment_method preserved alongside suppression flags', () => {
    const body = buildZbBody(baseSfJob, linkage);
    expect(body.assigned_providers).toEqual(['1733415450171x961236852912174200']);
    expect(body.assignment_method).toBe('auto');
    // Suppression flags do NOT replace the assignment behavior — ZB still
    // applies the explicit provider list; ZB just doesn't notify them.
  });
});
