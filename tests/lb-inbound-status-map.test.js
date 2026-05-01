const { mapLbToSfStatus, isKnownLbStatus, normalizeLbStatus } = require('../services/lb-inbound-status-map')

describe('lb-inbound-status-map', () => {
  describe('mapLbToSfStatus', () => {
    test.each([
      ['scheduled',   'scheduled'],
      ['in_progress', 'in-progress'],
      ['completed',   'completed'],
      ['cancelled',   'cancelled'],
      ['no_show',     'no-show'],
    ])('maps actionable LB status %s → SF %s', (lb, sf) => {
      expect(mapLbToSfStatus(lb)).toBe(sf)
    })

    test.each([
      'new', 'contacted', 'engaged', 'quoted', 'booked', 'lost', 'archived',
    ])('returns null for non-actionable LB status %s', (lb) => {
      expect(mapLbToSfStatus(lb)).toBeNull()
    })

    test('returns null for unknown statuses', () => {
      expect(mapLbToSfStatus('mystery')).toBeNull()
      expect(mapLbToSfStatus(null)).toBeNull()
      expect(mapLbToSfStatus(undefined)).toBeNull()
      expect(mapLbToSfStatus('')).toBeNull()
    })

    test('case-insensitive + trims whitespace', () => {
      expect(mapLbToSfStatus(' SCHEDULED ')).toBe('scheduled')
      expect(mapLbToSfStatus('In_Progress')).toBe('in-progress')
    })
  })

  describe('isKnownLbStatus', () => {
    test('recognizes the full canonical pipeline', () => {
      const known = ['new','contacted','engaged','quoted','booked','scheduled','in_progress','completed','lost','cancelled','no_show','archived']
      for (const s of known) expect(isKnownLbStatus(s)).toBe(true)
    })
    test('rejects unknown values', () => {
      expect(isKnownLbStatus('hired')).toBe(false)
      expect(isKnownLbStatus('done')).toBe(false)
      expect(isKnownLbStatus('')).toBe(false)
      expect(isKnownLbStatus(null)).toBe(false)
    })
  })

  describe('normalizeLbStatus', () => {
    test('lowercases + trims', () => {
      expect(normalizeLbStatus(' Scheduled ')).toBe('scheduled')
    })
    test('handles non-strings', () => {
      expect(normalizeLbStatus(null)).toBe('')
      expect(normalizeLbStatus(undefined)).toBe('')
    })
  })

  // Inbound writes are loop-guarded in lb-outbound-delivery.js
  // (source='leadbridge' → skipped_loop), so the outbound allowlist
  // never sees these statuses in practice. We don't enforce a strict
  // subset relationship — the loop guard is the load-bearing
  // invariant, not the allowlist overlap.
})
