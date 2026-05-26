'use strict';

// Recurring-customer attribution classifier.
//
// Stage-3 of the LB historical recovery program. Operates on the same
// "LB-completed lead without an SF job linked to it" gap that Stage-1
// Part-2 classifier covers, but uses a different decision tree:
//
//   Multi-job customers are NOT ambiguity. They are recurring customers.
//   Multi-job + name match + customer.source aligns with LB platform
//   ⇒ this is a stable LB acquisition with a recurring service relationship.
//
// Output subtiers (returned from classifyRecurring):
//   recurring_customer_high_confidence
//   true_multi_candidate_ambiguity        (rare; multi-customer-on-same-phone)
//   weak_identity                          (no source attribution + no LB identity)
//   weak_timing                            (timing-only weakness)
//   duplicate_phone_collision              (phone shared with another LB ext)
//   conflicting_acquisition_source         (customer.source claims different platform)
//
// Pure functions — no DB access. Caller fetches the context and passes it in.

const ALLOWED_CHANNELS = new Set(['thumbtack', 'yelp']);

function last10(p) {
  if (!p) return null;
  const d = String(p).replace(/[^0-9]/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
}

function nameMatch(a, b) {
  if (!a || !b) return false;
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z]/g, '').slice(0, 10);
  return norm(a) === norm(b) || (norm(a).length >= 4 && (norm(a).startsWith(norm(b).slice(0, 4)) || norm(b).startsWith(norm(a).slice(0, 4))));
}

// True iff customers.source string is consistent with the LB platform that
// acquired this customer. Returns:
//   true   — clearly aligned (e.g., 'Thumbtack Tampa' for an LB-thumbtack lead)
//   false  — clearly contradictory (e.g., 'Yelp Tampa' for an LB-thumbtack lead)
//   null   — unknown / unattributed (e.g., empty, 'Other')
function customerSourceAlignsWithLb(custSource, lbPlatform) {
  if (!custSource) return null;
  const s = String(custSource).toLowerCase();
  if (lbPlatform === 'thumbtack') {
    if (/thumbtack/.test(s)) return true;
    if (/yelp/.test(s)) return false;
    return null;
  }
  if (lbPlatform === 'yelp') {
    if (/yelp/.test(s)) return true;
    if (/thumbtack/.test(s)) return false;
    return null;
  }
  return null;
}

// Detect recurring cadence from a list of jobs (scheduled_date or created_at).
// Returns { isRecurring, medianGapDays, gapCV, gapCount }.
// Rule: ≥2 gaps AND median gap in [4, 90] days AND coefficient-of-variation < 0.5.
function cadence(jobs) {
  const dates = jobs
    .map(j => j.scheduled_date || j.created_at)
    .filter(Boolean)
    .map(d => new Date(d).getTime())
    .filter(t => !Number.isNaN(t))
    .sort((a, b) => a - b);
  if (dates.length < 3) return { isRecurring: false, gapCount: 0, medianGapDays: null, gapCV: null };
  const gaps = [];
  for (let i = 1; i < dates.length; i++) gaps.push((dates[i] - dates[i - 1]) / 86400000);
  const sorted = [...gaps].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const variance = gaps.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / gaps.length;
  const stdev = Math.sqrt(variance);
  const cv = mean === 0 ? 1 : stdev / mean;
  const isRecurring = gaps.length >= 2 && med >= 4 && med <= 90 && cv < 0.5;
  return {
    isRecurring,
    medianGapDays: Math.round(med * 10) / 10,
    gapCV: Math.round(cv * 100) / 100,
    gapCount: gaps.length,
  };
}

// Address-consistency check: of N jobs with address data, what fraction
// share the most common (street, zip) pair?
function addressConsistency(jobs) {
  const counts = {};
  let total = 0;
  for (const j of jobs) {
    const street = (j.service_address_street || '').toLowerCase().trim();
    const zip = (j.service_address_zip || '').toLowerCase().trim();
    if (!street && !zip) continue;
    const k = `${street}|${zip}`;
    counts[k] = (counts[k] || 0) + 1;
    total++;
  }
  if (total === 0) return { distinctAddresses: 0, modeShare: 0, total: 0 };
  const max = Math.max(...Object.values(counts));
  return {
    distinctAddresses: Object.keys(counts).length,
    modeShare: Math.round((max / total) * 100) / 100,
    total,
  };
}

// Pick the acquisition job — the job we'll stamp `lb_external_request_id`
// onto. Rules (in order):
//   1. First job within [lb_created - 7d, lb_created + 180d]
//   2. Otherwise, the earliest job overall (for ZB-first customers whose
//      original conversion job pre-dates SF's awareness)
// Excludes jobs that already have lb_external_request_id (idempotency).
function pickAcquisitionJob(lbCreatedAt, jobs) {
  const eligible = jobs.filter(j => j.lb_external_request_id == null);
  if (eligible.length === 0) return null;
  const lbT = new Date(lbCreatedAt).getTime();
  if (Number.isNaN(lbT)) {
    // No reliable LB createdAt — pick earliest overall
    return [...eligible].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0];
  }
  const winStart = lbT - 7 * 86400000;
  const winEnd = lbT + 180 * 86400000;
  const inWindow = eligible
    .filter(j => {
      const t = new Date(j.created_at).getTime();
      return !Number.isNaN(t) && t >= winStart && t <= winEnd;
    })
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  if (inWindow.length > 0) return inWindow[0];
  // Fallback: earliest job overall
  return [...eligible].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0];
}

/**
 * Classify a single LB-completed lead → SF customer match into one of
 * the six subtiers. Caller supplies:
 *   lbLead    { externalRequestId, customerName, customerPhone,
 *               platform, businessId, createdAt, status }
 *   custMatch { id, first_name, last_name, source, ... }   // null if no match
 *   peers     [customers]  — all customers sharing the LB phone last-10
 *   jobs      [jobs]       — jobs for this customer (sorted not required)
 *   identities[]           — identity rows for this customer
 *   phoneCollisionExts []  — other LB exts that share this phone (excluding self)
 */
function classifyRecurring({ lbLead, custMatch, peers, jobs, identities, phoneCollisionExts }) {
  const others = (phoneCollisionExts || []).filter(e => e !== lbLead.externalRequestId);
  if (others.length > 0) {
    return { subtier: 'duplicate_phone_collision', reason: `phone_shared_with_${others.length}_other_lb_lead(s)`, otherExts: others };
  }
  if (!custMatch) {
    return { subtier: 'weak_identity', reason: 'no_customer_match' };
  }
  if ((peers || []).length > 1) {
    return { subtier: 'true_multi_candidate_ambiguity', reason: `${peers.length}_customers_share_phone` };
  }

  const alignment = customerSourceAlignsWithLb(custMatch.source, lbLead.platform);
  if (alignment === false) {
    return {
      subtier: 'conflicting_acquisition_source',
      reason: `cust.source='${custMatch.source}' vs lb.platform='${lbLead.platform}'`,
    };
  }

  const cad = cadence(jobs || []);
  const addr = addressConsistency(jobs || []);
  const hasIsRecurringFlag = (jobs || []).some(j => j.is_recurring === true || (j.recurring_frequency && j.recurring_frequency !== ''));
  const namesAlign = nameMatch(lbLead.customerName, `${custMatch.first_name || ''} ${custMatch.last_name || ''}`.trim());
  const lbIdentities = (identities || []).filter(i => i.source_channel === 'leadbridge').length;
  const recurringSignal = cad.isRecurring || hasIsRecurringFlag || ((jobs || []).length >= 3 && addr.modeShare >= 0.66);

  // HIGH path 1: aligned source + name match + measurable recurring signal
  if ((alignment === true || lbIdentities > 0) && namesAlign && recurringSignal) {
    return {
      subtier: 'recurring_customer_high_confidence',
      reason: 'source_aligned_plus_recurring_signal',
      cadence: cad,
      address: addr,
      jobs_total: (jobs || []).length,
    };
  }
  // HIGH path 2: aligned source + name match + ≥2 jobs (multi-touch stability)
  if ((alignment === true || lbIdentities > 0) && namesAlign && (jobs || []).length >= 2) {
    return {
      subtier: 'recurring_customer_high_confidence',
      reason: 'source_aligned_plus_multi_touch',
      cadence: cad,
      address: addr,
      jobs_total: (jobs || []).length,
    };
  }
  // Multi-job but no source alignment / no name match → real ambiguity
  if (namesAlign && cad.gapCount > 0 && !cad.isRecurring && (jobs || []).length >= 2) {
    return { subtier: 'true_multi_candidate_ambiguity', reason: `multi_jobs_no_recurrence_alignment=${alignment}` };
  }
  // No source alignment AND no LB identity → weak signal
  if (alignment !== true && lbIdentities === 0) {
    return { subtier: 'weak_identity', reason: `alignment=${alignment}_no_lb_identity` };
  }
  return { subtier: 'weak_timing', reason: `timing_only_weakness_alignment=${alignment}_jobs=${(jobs || []).length}` };
}

module.exports = {
  classifyRecurring,
  customerSourceAlignsWithLb,
  cadence,
  addressConsistency,
  pickAcquisitionJob,
  nameMatch,
  last10,
  ALLOWED_CHANNELS,
};
