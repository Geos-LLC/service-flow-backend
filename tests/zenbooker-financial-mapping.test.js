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

  test('B. computed implicit tip when ZB tip is null and amount_paid > subtotal+fee+tax', () => {
    const zb = fixtureZb142065({
      invoice: {
        ...fixtureZb142065().invoice,
        tip: null,
        // amount_paid 204.37 - subtotal 179 - tax 0 - adjustment 5.37 = 20.00 implicit
      },
    });
    const out = mapJobFinancials(zb);
    expect(out.tip_amount).toBe(20);
    expect(out._tip_source).toBe('computed_implicit');
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

  test('empty invoice → SF prices not overwritten (subtotal 0 → keys omitted)', () => {
    const zb = { id: 'x', invoice: {} };
    const out = mapJobFinancials(zb);
    expect('service_price' in out).toBe(false);
    expect('total' in out).toBe(false);
    // But the always-present fields are still set
    expect(out.taxes).toBe(0);
    expect(out.additional_fees).toBe(0);
  });

  test('missing duration → key omitted (does not overwrite SF duration with 0)', () => {
    const zb = { id: 'x', estimated_duration_seconds: null, invoice: {} };
    const out = mapJobFinancials(zb);
    expect('duration' in out).toBe(false);
  });
});

describe('resolveTip — direct unit', () => {
  test('explicit ZB tip beats preserve-SF', () => {
    expect(resolveTip({
      explicitZbTip: 20, existingSfTipAmount: 15,
      amountPaid: 0, subtotal: 0, taxes: 0, adjustmentTotal: 0,
    })).toEqual({ resolvedTip: 20, tipSource: 'explicit_zb' });
  });

  test('preserve-SF beats computed implicit', () => {
    expect(resolveTip({
      explicitZbTip: 0, existingSfTipAmount: 12,
      amountPaid: 100, subtotal: 80, taxes: 0, adjustmentTotal: 0,
    })).toEqual({ resolvedTip: null, tipSource: 'preserve_sf' });
  });

  test('zero tip everywhere when nothing computed', () => {
    expect(resolveTip({
      explicitZbTip: 0, existingSfTipAmount: 0,
      amountPaid: 80, subtotal: 80, taxes: 0, adjustmentTotal: 0,
    })).toEqual({ resolvedTip: 0, tipSource: 'no_tip' });
  });

  test('rounding to cents on computed', () => {
    // overage = 100.005 → cents 100.005 * 100 = 10000.5 → round → 10001 → /100 → 100.01
    const out = resolveTip({
      explicitZbTip: 0, existingSfTipAmount: 0,
      amountPaid: 180.005, subtotal: 80, taxes: 0, adjustmentTotal: 0,
    });
    expect(out.tipSource).toBe('computed_implicit');
    expect(out.resolvedTip).toBe(100.01);
  });

  test('overage under half a cent → no tip', () => {
    expect(resolveTip({
      explicitZbTip: 0, existingSfTipAmount: 0,
      amountPaid: 80.001, subtotal: 80, taxes: 0, adjustmentTotal: 0,
    })).toEqual({ resolvedTip: 0, tipSource: 'no_tip' });
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
