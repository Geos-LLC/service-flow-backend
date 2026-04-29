'use strict';

// Generic Data Import — shared importer logic for the /api/data-import/import
// endpoint. Handles five import types:
//
//   * customers     → delegated to existing /api/booking-koala/import handler
//   * jobs          → delegated to existing /api/booking-koala/import handler
//   * team_members  → handled here (importTeamMembers)
//   * services      → handled here (importServices)
//   * territories   → handled here (importTerritories)
//
// Customers / jobs delegate because the existing BK route already has battle-
// tested dedup, on-the-fly customer/team/territory creation, and ledger sync.
// New types are simple inserts — no need to reuse that complexity.

/**
 * Apply a CSV-header → SF-field mapping to raw rows.
 *
 * @param {Array<Object>} rows  Raw rows keyed by CSV header
 * @param {Object} mapping      { sfFieldKey: csvHeaderName }
 * @returns {Array<Object>}     Rows keyed by SF field key, with raw headers
 *                              preserved as fallback (BK route relies on this).
 */
function applyMapping(rows, mapping) {
  if (!Array.isArray(rows)) return [];
  if (!mapping || typeof mapping !== 'object') return rows.slice();

  return rows.map((row) => {
    const out = { ...row }; // preserve raw headers
    for (const [sfField, csvHeader] of Object.entries(mapping)) {
      if (!csvHeader) continue;
      const v = row[csvHeader];
      if (v !== undefined && v !== null && v !== '') {
        out[sfField] = v;
      }
    }
    return out;
  });
}

const TEAM_ROLE_DEFAULTS = ['cleaner', 'manager', 'office', 'admin'];

function pick(row, keys) {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const cleaned = String(v).replace(/[$,\s]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function toBool(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim().toLowerCase();
  if (['true', 'yes', '1', 'y', 'active'].includes(s)) return true;
  if (['false', 'no', '0', 'n', 'inactive'].includes(s)) return false;
  return null;
}

/**
 * Import team members. Inserts only — no password generation, no invite emails.
 * User can send invites manually after import.
 */
async function importTeamMembers(supabase, userId, rows, settings, sendProgress) {
  const result = { imported: 0, skipped: 0, errors: [] };
  if (!Array.isArray(rows) || rows.length === 0) return result;

  const total = rows.length;
  const skipDuplicates = settings && settings.skipDuplicates !== false;
  const updateExisting = settings && settings.updateExisting === true;

  // Pre-load existing emails for dedup
  const existingByEmail = new Map();
  if (skipDuplicates) {
    let page = 0;
    while (true) {
      const { data, error } = await supabase
        .from('team_members')
        .select('id, email')
        .eq('user_id', userId)
        .range(page * 1000, (page + 1) * 1000 - 1);
      if (error || !data || data.length === 0) break;
      for (const tm of data) {
        if (tm.email) existingByEmail.set(tm.email.toLowerCase().trim(), tm.id);
      }
      if (data.length < 1000) break;
      page++;
    }
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const firstName = pick(row, ['firstName', 'first_name', 'First Name', 'First name']);
      const lastName = pick(row, ['lastName', 'last_name', 'Last Name', 'Last name']);
      const email = pick(row, ['email', 'Email', 'Email Address']);
      const phone = pick(row, ['phone', 'Phone', 'Phone Number', 'mobile']);
      const role = (pick(row, ['role', 'Role']) || 'cleaner').toLowerCase();
      const hourlyRate = toNumber(pick(row, ['hourlyRate', 'hourly_rate', 'Hourly Rate']));
      const commission = toNumber(pick(row, ['commission', 'commission_percentage', 'Commission %', 'Commission']));
      const isActive = toBool(pick(row, ['isActive', 'is_active', 'Active', 'Status']));
      const city = pick(row, ['city', 'City']);
      const state = pick(row, ['state', 'State']);
      const zip = pick(row, ['zipCode', 'zip_code', 'Zip', 'Zip Code', 'Zip/Postal Code']);
      const color = pick(row, ['color', 'Color']);

      if (!firstName || !lastName) {
        result.errors.push(`Row ${i + 1}: First name and last name are required`);
        continue;
      }
      if (!email) {
        result.errors.push(`Row ${i + 1}: Email is required (team_members.email is NOT NULL)`);
        continue;
      }

      const emailNorm = email.toLowerCase().trim();
      const existingId = existingByEmail.get(emailNorm);

      const payload = {
        user_id: userId,
        first_name: firstName,
        last_name: lastName,
        email: emailNorm,
        phone: phone || null,
        role: TEAM_ROLE_DEFAULTS.includes(role) ? role : 'cleaner',
        hourly_rate: hourlyRate,
        commission_percentage: commission,
        is_active: isActive === null ? true : isActive,
        city: city || null,
        state: state || null,
        zip_code: zip || null,
        color: color || null,
        is_service_provider: true,
      };
      // strip nulls for cleaner inserts (let DB defaults apply)
      Object.keys(payload).forEach((k) => payload[k] === null && delete payload[k]);

      if (existingId) {
        if (updateExisting) {
          const { error: upErr } = await supabase.from('team_members').update(payload).eq('id', existingId);
          if (upErr) result.errors.push(`Row ${i + 1}: ${upErr.message}`);
          else result.imported++;
        } else {
          result.skipped++;
        }
      } else {
        const { error: insErr } = await supabase.from('team_members').insert(payload);
        if (insErr) result.errors.push(`Row ${i + 1}: ${insErr.message}`);
        else {
          result.imported++;
          existingByEmail.set(emailNorm, true); // prevent dupes within batch
        }
      }
    } catch (e) {
      result.errors.push(`Row ${i + 1}: ${e.message}`);
    }

    if (sendProgress && ((i + 1) % 10 === 0 || i === rows.length - 1)) {
      sendProgress({
        current: i + 1,
        total,
        imported: result.imported,
        skipped: result.skipped,
        errors: result.errors.length,
      });
    }
  }

  return result;
}

/**
 * Import services (flat — no extras/modifiers).
 */
async function importServices(supabase, userId, rows, settings, sendProgress) {
  const result = { imported: 0, skipped: 0, errors: [] };
  if (!Array.isArray(rows) || rows.length === 0) return result;

  const total = rows.length;
  const skipDuplicates = settings && settings.skipDuplicates !== false;
  const updateExisting = settings && settings.updateExisting === true;

  // Pre-load existing service names for dedup
  const existingByName = new Map();
  if (skipDuplicates) {
    let page = 0;
    while (true) {
      const { data, error } = await supabase
        .from('services')
        .select('id, name')
        .eq('user_id', userId)
        .range(page * 1000, (page + 1) * 1000 - 1);
      if (error || !data || data.length === 0) break;
      for (const s of data) {
        if (s.name) existingByName.set(s.name.toLowerCase().trim(), s.id);
      }
      if (data.length < 1000) break;
      page++;
    }
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const name = pick(row, ['name', 'Name', 'serviceName', 'service_name', 'Service Name', 'Service']);
      const description = pick(row, ['description', 'Description']);
      const price = toNumber(pick(row, ['price', 'Price', 'Amount']));
      const duration = (() => {
        const raw = pick(row, ['duration', 'Duration', 'Duration (minutes)', 'Estimated job length (HH:MM)']);
        if (!raw) return null;
        if (raw.includes(':')) {
          const [h, m] = raw.split(':');
          return (parseInt(h, 10) || 0) * 60 + (parseInt(m, 10) || 0);
        }
        return parseInt(raw, 10) || null;
      })();
      const category = pick(row, ['category', 'Category']);
      const isActive = toBool(pick(row, ['isActive', 'is_active', 'Active', 'Status']));

      if (!name) {
        result.errors.push(`Row ${i + 1}: Service name is required`);
        continue;
      }

      const nameNorm = name.toLowerCase().trim();
      const existingId = existingByName.get(nameNorm);

      const payload = {
        user_id: userId,
        name,
        description: description || null,
        price,
        duration,
        category: category || null,
        is_active: isActive === null ? true : isActive,
      };
      Object.keys(payload).forEach((k) => payload[k] === null && delete payload[k]);

      if (existingId) {
        if (updateExisting) {
          const { error: upErr } = await supabase.from('services').update(payload).eq('id', existingId);
          if (upErr) result.errors.push(`Row ${i + 1}: ${upErr.message}`);
          else result.imported++;
        } else {
          result.skipped++;
        }
      } else {
        const { error: insErr } = await supabase.from('services').insert(payload);
        if (insErr) result.errors.push(`Row ${i + 1}: ${insErr.message}`);
        else {
          result.imported++;
          existingByName.set(nameNorm, true);
        }
      }
    } catch (e) {
      result.errors.push(`Row ${i + 1}: ${e.message}`);
    }

    if (sendProgress && ((i + 1) % 10 === 0 || i === rows.length - 1)) {
      sendProgress({
        current: i + 1,
        total,
        imported: result.imported,
        skipped: result.skipped,
        errors: result.errors.length,
      });
    }
  }

  return result;
}

/**
 * Import territories.
 */
async function importTerritories(supabase, userId, rows, settings, sendProgress) {
  const result = { imported: 0, skipped: 0, errors: [] };
  if (!Array.isArray(rows) || rows.length === 0) return result;

  const total = rows.length;
  const skipDuplicates = settings && settings.skipDuplicates !== false;
  const updateExisting = settings && settings.updateExisting === true;

  const existingByName = new Map();
  if (skipDuplicates) {
    const { data } = await supabase.from('territories').select('id, name').eq('user_id', userId);
    for (const t of data || []) {
      if (t.name) existingByName.set(t.name.toLowerCase().trim(), t.id);
    }
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const name = pick(row, ['name', 'Name', 'territoryName', 'Territory', 'Location']);
      const description = pick(row, ['description', 'Description']);
      const location = pick(row, ['location', 'Location', 'address', 'Address']);
      const city = pick(row, ['city', 'City']);
      const state = pick(row, ['state', 'State']);
      const radius = toNumber(pick(row, ['radius', 'radius_miles', 'Radius (miles)', 'Radius']));
      const timezone = pick(row, ['timezone', 'Timezone']);
      const zipsRaw = pick(row, ['zipCodes', 'zip_codes', 'Zip Codes', 'ZIPs']);
      const zip_codes = zipsRaw
        ? zipsRaw.split(/[,;\s]+/).map((z) => z.trim()).filter(Boolean)
        : null;

      if (!name) {
        result.errors.push(`Row ${i + 1}: Territory name is required`);
        continue;
      }

      const nameNorm = name.toLowerCase().trim();
      const existingId = existingByName.get(nameNorm);

      const payload = {
        user_id: userId,
        name,
        description: description || null,
        location: location || null,
        radius_miles: radius,
        timezone: timezone || null,
        zip_codes: zip_codes && zip_codes.length ? zip_codes : null,
      };
      // schema also has city/state but they're not always present — set if columns exist
      if (city) payload.city = city;
      if (state) payload.state = state;

      Object.keys(payload).forEach((k) => payload[k] === null && delete payload[k]);

      if (existingId) {
        if (updateExisting) {
          const { error: upErr } = await supabase.from('territories').update(payload).eq('id', existingId);
          if (upErr) result.errors.push(`Row ${i + 1}: ${upErr.message}`);
          else result.imported++;
        } else {
          result.skipped++;
        }
      } else {
        const { error: insErr } = await supabase.from('territories').insert(payload);
        if (insErr) result.errors.push(`Row ${i + 1}: ${insErr.message}`);
        else {
          result.imported++;
          existingByName.set(nameNorm, true);
        }
      }
    } catch (e) {
      result.errors.push(`Row ${i + 1}: ${e.message}`);
    }

    if (sendProgress && ((i + 1) % 5 === 0 || i === rows.length - 1)) {
      sendProgress({
        current: i + 1,
        total,
        imported: result.imported,
        skipped: result.skipped,
        errors: result.errors.length,
      });
    }
  }

  return result;
}

const SUPPORTED_TYPES = ['customers', 'jobs', 'team_members', 'services', 'territories'];

module.exports = {
  applyMapping,
  importTeamMembers,
  importServices,
  importTerritories,
  SUPPORTED_TYPES,
};
