/**
 * Pure ZB→SF lifecycle/status mapper.
 *
 * Mirrors the lifecycle subset of mapJob() in zenbooker-sync.js so the new
 * single-job reconcile endpoint can compute status + timestamp drift without
 * pulling lookups (customers/services/team/territories) it doesn't need.
 *
 * Pure: no I/O, no DB. Returns a plain object suitable for inspection +
 * status-change decisions. Caller decides what to write.
 */

'use strict';

// Mirror of STATUS_MAP in zenbooker-sync.js. Kept as a separate copy here
// because the source lives inside the module factory closure and isn't
// importable. If you change one, change the other (or extract it).
const STATUS_MAP = {
  'scheduled': 'scheduled',
  'rescheduled': 'rescheduled',
  'en-route': 'en-route',
  'en_route': 'en-route',
  'enroute': 'en-route',
  'started': 'started',
  'in-progress': 'started',
  'late': 'late',
  'complete': 'completed',
  'completed': 'completed',
};

function zbDateToLocal(isoDate, timezone) {
  if (!isoDate) return null;
  try {
    const d = new Date(isoDate);
    const opts = { timeZone: timezone || 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
    const parts = new Intl.DateTimeFormat('en-CA', opts).formatToParts(d);
    const get = (type) => (parts.find(p => p.type === type) || {}).value || '00';
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
  } catch {
    return String(isoDate).replace('T', ' ').replace(/\.000Z$/, '').replace('Z', '');
  }
}

/**
 * Map the lifecycle subset of a ZB job into SF jobs-table fields.
 *
 * Returns:
 *   {
 *     status: 'scheduled' | 'cancelled' | 'completed' | …,
 *     scheduled_date: 'YYYY-MM-DD HH:MM:SS' | null,   // local, in ZB tz
 *     start_time: ISO | undefined,                    // omitted if absent
 *     end_time:   ISO | undefined,                    // omitted if absent
 *     is_recurring: boolean,
 *     invoice_status: 'paid' | 'invoiced' | 'draft',
 *     payment_status: 'paid' | 'partial' | null,
 *     _zb_canceled: boolean,                          // diagnostic
 *     _zb_status_raw: string,                         // diagnostic
 *     _zb_rescheduled: boolean,                       // diagnostic
 *   }
 *
 * Status precedence matches mapJob(): canceled=true wins regardless of the
 * raw status string. STATUS_MAP fallback is 'pending'.
 */
function mapJobLifecycle(zbJob) {
  const inv = (zbJob && zbJob.invoice) || {};
  const zbStatusRaw = (zbJob && zbJob.status) || '';
  const zbCanceled = !!(zbJob && zbJob.canceled);
  const status = zbCanceled ? 'cancelled' : (STATUS_MAP[String(zbStatusRaw).toLowerCase()] || 'pending');

  const out = {
    status,
    scheduled_date: zbDateToLocal((zbJob && zbJob.start_date) || null, (zbJob && zbJob.timezone) || null),
    is_recurring: zbJob && zbJob.recurring === true,
    invoice_status: inv.status === 'paid' ? 'paid' : (inv.status === 'unpaid' ? 'invoiced' : 'draft'),
    payment_status: inv.status === 'paid' ? 'paid' : (parseFloat(inv.amount_paid) > 0 ? 'partial' : null),
    _zb_canceled: zbCanceled,
    _zb_status_raw: zbStatusRaw,
    _zb_rescheduled: !!(zbJob && zbJob.rescheduled),
  };
  if (zbJob && zbJob.started_at) out.start_time = zbJob.started_at;
  if (zbJob && zbJob.completed_at) out.end_time = zbJob.completed_at;
  return out;
}

/**
 * Strip diagnostic underscore-prefixed fields before sending to DB.
 */
function stripLifecycleDiagnostics(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!k.startsWith('_')) out[k] = v;
  }
  return out;
}

module.exports = {
  mapJobLifecycle,
  stripLifecycleDiagnostics,
  STATUS_MAP,
  zbDateToLocal,
};
