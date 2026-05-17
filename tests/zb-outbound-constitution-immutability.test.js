/**
 * Phase A contract test — Synchronization Constitution §3.1 immutability.
 *
 * Source-text scan: NO outbound module deletes or updates cleaner_ledger
 * rows. Outbound emits intent and reads — it never writes ledger.
 */

const fs = require('fs');
const path = require('path');

const FILES = [
  'lib/zb-outbound-delivery.js',
  'workers/zb-outbound-drainer.js',
  'zb-outbound.js',
  'lib/zb-body-observe.js',
];

describe('outbound modules MUST NOT touch cleaner_ledger', () => {
  for (const rel of FILES) {
    test(`${rel} — no cleaner_ledger writes`, () => {
      const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      // Forbidden patterns
      expect(src).not.toMatch(/from\(['"]cleaner_ledger['"]\)/);
      expect(src).not.toMatch(/DELETE\s+FROM\s+cleaner_ledger/i);
      expect(src).not.toMatch(/UPDATE\s+cleaner_ledger/i);
      expect(src).not.toMatch(/INSERT\s+INTO\s+cleaner_ledger/i);
    });
  }

  test('migration 044 does not reference cleaner_ledger', () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '044_zb_outbound_commands.sql'), 'utf8');
    expect(sql).not.toMatch(/cleaner_ledger/i);
  });

  test('migration 045 does not reference cleaner_ledger', () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '045_team_member_provider_mappings.sql'), 'utf8');
    expect(sql).not.toMatch(/cleaner_ledger/i);
  });
});

describe('outbound modules MUST NOT touch settled-batch surfaces', () => {
  for (const rel of FILES) {
    test(`${rel} — no payout_batch / payout_batch_id writes`, () => {
      const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      expect(src).not.toMatch(/from\(['"]cleaner_payout_batch['"]\)/);
      expect(src).not.toMatch(/payout_batch_id\s*:/); // no assignment to that column
    });
  }
});
