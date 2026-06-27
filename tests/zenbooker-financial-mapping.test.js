/**
 * Pure tests for the ZB→SF financial-field mapper.
 *
 * Covers the tip rule (explicit > preserve-SF > computed) plus the full
 * field set written by mapJobFinancials. Job 142065 is the canonical
 * regression fixture: ZB subtotal 179, tip 20, total 204.37, fee 5.37.
 */

const {
  mapJobFinancials,
  resolveTip,
  mapAdjustments,
  stripDiagnostics,
} = require('../lib/zenbooker-financial');

// Real ZB payload for job 142065 (Kim Stiles, Regular Cleaning, 2026-05-07)
function fixtureZb142065(overrides = {}) {
  const base = {
    id: '1777298942262x477282477062750200',
    estimated_duration_seconds: 12600,
    invoice: {
      status: 'paid',
      amount_paid: '204.37',
      amount_due: '0.00',
      subtotal: '179.00',
      discount: null,
      discount_amount: null,
      coupon: null,
      coupon_amount: null,
      tax_amount: '0.00',
      tip: '20.00',
      total: '204.37',
      adjustment_total: 5.37,
      adjustments_applied: [
        {
          id: 'adj_zb_1',
          name: 'Processing fee',
          adjustment_type: 'fee',
          adjustment_amount: 5.37,
          value: 0.03,
          value_type: 'percentage',
        },
      ],
    },
  };
  return { ...base, ...overrides };
}

describe('mapJobFinancials — tip rule', () => {
  test('A. explicit ZB tip wins (142065 fixture)', () => {
    const out = mapJobFinancials(fixtureZb142065());
    expect(out.tip_amount).toBe(20);
    expect(out._tip_source).toBe('explicit_zb');
    expect(out.service_price).toBe(179);
    expect(out.total).toBe(204.37);
  });

  test('B. amount_paid overage above subtotal+fee+tax is NOT treated as a tip', () => {
    // Reversed from earlier behavior. ZB invoices sometimes report a
    // positive overage that is actually a processing fee the customer
    // covered for the merchant (not visible in adjustment_total). We
    // refuse to guess — only an explicit ZB tip counts.
    const zb = fixtureZb142065({
      invoice: {
        ...fixtureZb142065().invoice,
        tip: null,
        // amount_paid 204.37 - subtotal 179 - tax 0 - adjustment 5.37 = 20.00 overage
        // — could be a tip OR a fee. Resolver writes 0.
      },
    });
    const out = mapJobFinancials(zb);
    expect(out.tip_amount).toBe(0);
    expect(out._tip_source).toBe('no_tip');
  });

  test('C. amount_paid exactly equals subtotal+fee → no tip', () => {
    const zb = fixtureZb142065({
      invoice: {
        ...fixtureZb142065().invoice,
        tip: null,
        amount_paid: '184.37', // subtotal 179 + fee 5.37 = 184.37
        total: '184.37',
      },
    });
    const out = mapJobFinancials(zb);
    expect(out.tip_amount).toBe(0);
    expect(out._tip_source).toBe('no_tip');
  });

  test('D. underpayment (amount_paid < subtotal+fee) → tip clamped to 0', () => {
    const zb = fixtureZb142065({
      invoice: {
        ...fixtureZb142065().invoice,
        tip: null,
        amount_paid: '100.00',
        total: '184.37',
      },
    });
    const out = mapJobFinancials(zb);
    expect(out.tip_amount).toBe(0);
    expect(out._tip_source).toBe('no_tip');
  });

  test('E. ZB tip 0 + SF has manual tip 15 → preserve SF (tip_amount omitted from update)', () => {
    const zb = fixtureZb142065({
      invoice: {
        ...fixtureZb142065().invoice,
        tip: '0.00',
        amount_paid: '184.37', // no implicit overage either
        total: '184.37',
      },
    });
    const out = mapJobFinancials(zb, { existingSfTipAmount: 15 });
    expect(out._tip_source).toBe('preserve_sf');
    expect('tip_amount' in out).toBe(false); // key omitted entirely
  });

  test('E2. ZB explicit tip 20 still wins even when SF already has tip 15', () => {
    // Authoritative ZB tip overrides SF — explicit takes priority over preserve.
    const out = mapJobFinancials(fixtureZb142065(), { existingSfTipAmount: 15 });
    expect(out.tip_amount).toBe(20);
    expect(out._tip_source).toBe('explicit_zb');
  });
});

describe('mapJobFinancials — non-tip fields', () => {
  test('F. duration converted from estimated_duration_seconds (12600s → 210min)', () => {
    const out = mapJobFinancials(fixtureZb142065());
    expect(out.duration).toBe(210);
  });

  test('142065 full canonical mapping', () => {
    const out = stripDiagnostics(mapJobFinancials(fixtureZb142065()));
    expect(out).toEqual({
      service_price: 179,
      price: 179,
      total: 204.37,
      total_amount: 204.37,
      tip_amount: 20,
      additional_fees: 5.37,
      fees_breakdown: [
        {
          name: 'Processing fee',
          type: 'fee',
          amount: 5.37,
          rate: 0.03,
          rate_type: 'percentage',
          zb_id: 'adj_zb_1',
        },
      ],
      taxes: 0,
      discount: 0,
      duration: 210,
    });
  });

  test('empty invoice → SF prices and fees not overwritten (no source signal)', () => {
    const zb = { id: 'x', invoice: {} };
    const out = mapJobFinancials(zb);
    expect('service_price' in out).toBe(false);
    expect('total' in out).toBe(false);
    // Adjustment fields omitted because invoice doesn't include adjustment_total
    // or adjustments_applied at all — we can't tell "no fees" from "field absent".
    expect('additional_fees' in out).toBe(false);
    expect('fees_breakdown' in out).toBe(false);
    // Always-present fields still default to 0
    expect(out.taxes).toBe(0);
  });

  test('invoice from /jobs/:id (no adjustment_* fields) → fees omitted, SF preserved', () => {
    // Real ZB /jobs/:id returns the invoice WITHOUT adjustment_total / adjustments_applied.
    // The mapper must NOT clobber existing SF additional_fees/fees_breakdown to 0/null.
    const zb = {
      id: 'x', estimated_duration_seconds: 12600,
      invoice: { subtotal: '179.00', total: '204.37', tip: '20.00', amount_paid: '204.37', tax_amount: '0.00', status: 'paid' },
    };
    const out = mapJobFinancials(zb);
    expect(out.service_price).toBe(179);
    expect(out.tip_amount).toBe(20);
    expect('additional_fees' in out).toBe(false);
    expect('fees_breakdown' in out).toBe(false);
  });

  test('invoice WITH adjustment_total: 0 (zero fees explicit) → writes 0', () => {
    // When the source explicitly says "zero adjustments", we DO write 0 to clear stale values.
    const zb = {
      id: 'x',
      invoice: {
        subtotal: '100', total: '100', amount_paid: '100', tax_amount: '0',
        adjustment_total: 0, adjustments_applied: [],
      },
    };
    const out = mapJobFinancials(zb);
    expect(out.additional_fees).toBe(0);
    expect(out.fees_breakdown).toBeNull(); // empty array → null per mapAdjustments
  });

  test('missing duration → key omitted (does not overwrite SF duration with 0)', () => {
    const zb = { id: 'x', estimated_duration_seconds: null, invoice: {} };
    const out = mapJobFinancials(zb);
    expect('duration' in out).toBe(false);
  });
});

describe('resolveTip — direct unit', () => {
  test('explicit ZB tip beats preserve-SF (signal irrelevant)', () => {
    expect(resolveTip({
      explicitZbTip: 20, existingSfTipAmount: 15,
      amountPaid: 0, subtotal: 0, taxes: 0, adjustmentTotal: 0,
      hasAdjustmentSignal: false,
    })).toEqual({ resolvedTip: 20, tipSource: 'explicit_zb' });
  });

  test('preserve-SF beats computed implicit (signal irrelevant)', () => {
    expect(resolveTip({
      explicitZbTip: 0, existingSfTipAmount: 12,
      amountPaid: 100, subtotal: 80, taxes: 0, adjustmentTotal: 0,
      hasAdjustmentSignal: false,
    })).toEqual({ resolvedTip: null, tipSource: 'preserve_sf' });
  });

  test('zero tip everywhere when nothing computed (with adjustment signal)', () => {
    expect(resolveTip({
      explicitZbTip: 0, existingSfTipAmount: 0,
      amountPaid: 80, subtotal: 80, taxes: 0, adjustmentTotal: 0,
      hasAdjustmentSignal: true,
    })).toEqual({ resolvedTip: 0, tipSource: 'no_tip' });
  });

  test('large overage with adjustment signal → still no tip (overage could be a fee)', () => {
    // Previously tested implicit-tip rounding. Behavior reversed: even with
    // adjustment data present, the overage is not assumed to be a tip.
    expect(resolveTip({
      explicitZbTip: 0, existingSfTipAmount: 0,
      amountPaid: 180.005, subtotal: 80, taxes: 0, adjustmentTotal: 0,
      hasAdjustmentSignal: true,
    })).toEqual({ resolvedTip: 0, tipSource: 'no_tip' });
  });

  test('tiny overage with adjustment signal → no tip (unchanged)', () => {
    expect(resolveTip({
      explicitZbTip: 0, existingSfTipAmount: 0,
      amountPaid: 80.001, subtotal: 80, taxes: 0, adjustmentTotal: 0,
      hasAdjustmentSignal: true,
    })).toEqual({ resolvedTip: 0, tipSource: 'no_tip' });
  });

  test('no adjustment signal + apparent overage → refuse to guess (omit tip_amount)', () => {
    // /jobs/:id payload pattern: amount_paid > subtotal but adjustment_total
    // wasn't included by the source — could be a tip OR a processing fee.
    // Mapper must refuse to write tip_amount (preserves whatever SF has).
    expect(resolveTip({
      explicitZbTip: 0, existingSfTipAmount: 0,
      amountPaid: 297.67, subtotal: 289, taxes: 0, adjustmentTotal: 0,
      hasAdjustmentSignal: false,
    })).toEqual({ resolvedTip: null, tipSource: 'no_adjustment_signal' });
  });
});

describe('mapJobFinancials — no_adjustment_signal regression (job 142150)', () => {
  test('/jobs/:id payload with overage but no adjustment fields → tip_amount OMITTED', () => {
    // Reproduction of the Ebony Davis #142150 bug: ZB /jobs/:id returned an
    // invoice with amount_paid=297.67, subtotal=289, no tip, no adjustment_total.
    // The overage of 8.67 was the processing fee (visible only on /invoices/:id),
    // not a customer tip. Before the fix, mapper wrote tip_amount=8.67 which then
    // got paid out to cleaners through the ledger.
    const zb = {
      id: 'x',
      invoice: {
        subtotal: '289.00', total: '297.67', amount_paid: '297.67',
        tax_amount: '0.00', status: 'paid',
        // no `tip`, no `adjustment_total`, no `adjustments_applied`
      },
    };
    const out = mapJobFinancials(zb);
    expect('tip_amount' in out).toBe(false);
    expect(out._tip_source).toBe('no_adjustment_signal');
  });

  test('explicit ZB tip still wins on /jobs/:id payload (signal not required)', () => {
    // When ZB does include a tip, we trust it regardless of adjustment visibility.
    const zb = {
      id: 'x',
      invoice: {
        subtotal: '179.00', total: '204.37', tip: '20.00', amount_paid: '204.37',
        tax_amount: '0.00', status: 'paid',
      },
    };
    const out = mapJobFinancials(zb);
    expect(out.tip_amount).toBe(20);
    expect(out._tip_source).toBe('explicit_zb');
  });

  test('preserve-SF still wins on /jobs/:id payload', () => {
    const zb = {
      id: 'x',
      invoice: { subtotal: '100', total: '100', amount_paid: '100', tax_amount: '0' },
    };
    const out = mapJobFinancials(zb, { existingSfTipAmount: 15 });
    expect('tip_amount' in out).toBe(false);
    expect(out._tip_source).toBe('preserve_sf');
  });
});

describe('mapAdjustments', () => {
  test('null input returns null', () => {
    expect(mapAdjustments(null)).toBeNull();
    expect(mapAdjustments(undefined)).toBeNull();
    expect(mapAdjustments([])).toBeNull();
  });

  test('maps each entry with safe number coercion', () => {
    const out = mapAdjustments([
      {
        id: 'a1',
        name: 'Processing fee',
        adjustment_type: 'fee',
        adjustment_amount: '5.37',
        value: '0.03',
        value_type: 'percentage',
      },
    ]);
    expect(out).toEqual([
      { name: 'Processing fee', type: 'fee', amount: 5.37, rate: 0.03, rate_type: 'percentage', zb_id: 'a1' },
    ]);
  });
});
