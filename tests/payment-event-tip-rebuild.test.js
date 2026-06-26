// Source-text scan tests for two ZB-sync payment fixes shipped together:
//
//   1. handlePaymentEvent rebuilds the ledger when job.tip_amount changed.
//      Bug: Stripe/card tips added in ZB after job.completed left SF's ledger
//      with only the earning row — no tip row — because the rebuild was gated
//      on `payment_method=cash`. Per-cleaner payroll under-paid the tip share.
//
//   2. The /connect webhook subscription list includes `invoice.payment_voided`.
//      Bug: ZB voids never reached SF, so duplicate-payment recoveries left
//      both completed transactions in place — double-counting payments and
//      inflating `cash_collected` (which incorrectly looked like worker debt).
//
// Source-text scans (rather than running the controller) match the rest of
// the zb-atomic-writes test style and remain valid as long as the relevant
// strings are present.

const fs = require('fs');
const path = require('path');

const ZB_SYNC_JS = fs.readFileSync(
  path.join(__dirname, '..', 'zenbooker-sync.js'),
  'utf8'
);

function sliceFn(source, fnSig) {
  const start = source.indexOf(fnSig);
  if (start < 0) return '';
  const end = source.indexOf('async function ', start + 50);
  return source.slice(start, end === -1 ? source.length : end);
}

describe('handlePaymentEvent — ledger rebuild also fires on tip change (not only cash)', () => {
  const block = sliceFn(ZB_SYNC_JS, 'async function handlePaymentEvent');

  test('handlePaymentEvent is present', () => {
    expect(block.length).toBeGreaterThan(0);
  });

  test('selects tip_amount on the pre-event job read so we can compare prev vs next', () => {
    // The job-fetch SELECT inside handlePaymentEvent must include tip_amount.
    expect(block).toMatch(/from\(['"]jobs['"]\)\s*\.select\([^)]*tip_amount/);
  });

  test('computes prev/next tip from job + update and triggers rebuild on change', () => {
    // Look for the gate variables introduced by the fix. Names can drift, but
    // SOME comparison of an old tip vs a new tip must guard the rebuild.
    expect(block).toMatch(/prevTip|previousTip|oldTip/);
    expect(block).toMatch(/nextTip|newTip|updatedTip/);
    expect(block).toMatch(/tipChanged|tip_changed/);
  });

  test('rebuild call sites include a non-cash path (cash-only gate has been widened)', () => {
    // Previous code: `if (cashTxCheck && cashTxCheck.length > 0) { rebuildLedger(...) }`
    // After fix: the same rebuildLedger sits under `if (hasCashTx || tipChanged) { ... }`
    // (or equivalent). Pin the wider gate so a future revert is loud.
    expect(block).toMatch(/hasCashTx\s*\|\|\s*tipChanged|tipChanged\s*\|\|\s*hasCashTx/);
  });

  test('rebuildLedger types still include earning, tip, incentive, cash_collected', () => {
    // The completion-derived set must not silently shrink.
    expect(block).toMatch(
      /rebuildLedger\([^)]*types:\s*\[\s*['"]earning['"]\s*,\s*['"]tip['"]\s*,\s*['"]incentive['"]\s*,\s*['"]cash_collected['"]\s*\]/
    );
  });
});

describe('ZB webhook subscription list — invoice.payment_voided is registered', () => {
  test('webhookEvents includes invoice.payment_voided', () => {
    // The single source-of-truth is the array literal inside the /connect
    // route. Find it and assert membership.
    const m = ZB_SYNC_JS.match(/const\s+webhookEvents\s*=\s*\[([^\]]+)\]/);
    expect(m).not.toBeNull();
    const events = m[1]
      .split(',')
      .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    expect(events).toEqual(expect.arrayContaining([
      'invoice.payment_succeeded',
      'invoice.payment_recorded',
      'invoice.payment_voided', // ← the fix
    ]));
  });

  test('event-name normalization still routes invoice.payment_voided through handlePaymentEvent', () => {
    // The webhook router rewrites `invoice.payment_*` → `invoice_payment.*`.
    // handlePaymentEvent's `invoice_payment.voided` branch must still exist.
    expect(ZB_SYNC_JS).toMatch(/invoice\.payment_/);
    expect(ZB_SYNC_JS).toMatch(/invoice_payment\.voided/);
  });
});
