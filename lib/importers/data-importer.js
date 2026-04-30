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
      // Keep the mapped key even when the cell is empty — passes the empty
      // value through so the backend can decide (clear-on-empty, retain
      // existing, or honor the user's blank). Previous behavior dropped
      // empty cells which silently masked them.
      const v = row[csvHeader];
      out[sfField] = v === undefined ? '' : v;
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

function toDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  // US "MM/DD/YYYY"
  if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(s)) {
    const [m, d, y] = s.split(/[\/\s]/);
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return s; // pass through ISO / Postgres-parseable
}

function toCsvArray(v) {
  if (!v) return null;
  if (Array.isArray(v)) return v;
  return String(v).split(/[,;]+/).map((x) => x.trim()).filter(Boolean);
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
      const salaryStartDate = toDate(pick(row, ['salaryStartDate', 'salary_start_date', 'Salary Start Date', 'Start Date', 'Hire Date']));
      const payoutScheduleType = pick(row, ['payoutScheduleType', 'payout_schedule_type', 'Payout Schedule', 'Pay Frequency']);
      const payoutDayOfWeek = (() => {
        const raw = pick(row, ['payoutDayOfWeek', 'payout_day_of_week', 'Payout Day']);
        if (raw == null) return null;
        if (/^\d+$/.test(raw)) return parseInt(raw, 10);
        const map = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
        return map[String(raw).toLowerCase()] ?? null;
      })();
      const payoutIntervalDays = toNumber(pick(row, ['payoutIntervalDays', 'payout_interval_days', 'Payout Interval']));
      const isActive = toBool(pick(row, ['isActive', 'is_active', 'Active']));
      const status = pick(row, ['status', 'Status']);
      const isServiceProvider = toBool(pick(row, ['isServiceProvider', 'is_service_provider', 'Service Provider']));
      const skills = toCsvArray(pick(row, ['skills', 'Skills', 'Specialties']));
      const location = pick(row, ['location', 'Location']);
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
        salary_start_date: salaryStartDate,
        payout_schedule_type: payoutScheduleType || null,
        payout_day_of_week: payoutDayOfWeek,
        payout_interval_days: payoutIntervalDays,
        is_active: isActive === null ? true : isActive,
        status: status ? String(status).toLowerCase() : null,
        is_service_provider: isServiceProvider === null ? true : isServiceProvider,
        skills: skills && skills.length ? skills : null,
        location: location || null,
        city: city || null,
        state: state || null,
        zip_code: zip || null,
        color: color || null,
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
      const requirePaymentMethod = toBool(pick(row, ['requirePaymentMethod', 'require_payment_method', 'Require Payment Method', 'CC Required']));

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
        require_payment_method: requirePaymentMethod === null ? false : requirePaymentMethod,
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
      const status = pick(row, ['status', 'Status']);
      const pricingMultiplier = toNumber(pick(row, ['pricingMultiplier', 'pricing_multiplier', 'Pricing Multiplier', 'Multiplier']));
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
        status: status ? String(status).toLowerCase() : null,
        pricing_multiplier: pricingMultiplier,
        zip_codes: zip_codes && zip_codes.length ? zip_codes : null,
      };

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

/**
 * Import leads into the `leads` table.
 *
 * Required FKs (pipeline_id, stage_id) are not in the CSV — we resolve them
 * by picking the user's default pipeline and its first stage.
 */
async function importLeads(supabase, userId, rows, settings, sendProgress) {
  const result = { imported: 0, skipped: 0, errors: [] };
  if (!Array.isArray(rows) || rows.length === 0) return result;

  // Resolve default pipeline + first stage once for the whole import.
  // Auto-create a starter pipeline + stages if the account has none, so
  // a first-time import doesn't dead-end with a setup error.
  let pipelineId;
  let stageId;
  {
    const { data: pipelines } = await supabase
      .from('pipelines')
      .select('id, is_default')
      .eq('user_id', userId)
      .order('is_default', { ascending: false })
      .order('id', { ascending: true });

    if (!pipelines || pipelines.length === 0) {
      const { data: newPipeline, error: pErr } = await supabase
        .from('pipelines')
        .insert({ user_id: userId, name: 'Default Pipeline', is_default: true })
        .select('id')
        .single();
      if (pErr || !newPipeline) {
        result.errors.push(`Could not auto-create default pipeline: ${pErr?.message || 'unknown error'}`);
        return result;
      }
      pipelineId = newPipeline.id;
      const starterStages = [
        { pipeline_id: pipelineId, name: 'New Lead',  position: 1, color: '#3B82F6' },
        { pipeline_id: pipelineId, name: 'Contacted', position: 2, color: '#F59E0B' },
        { pipeline_id: pipelineId, name: 'Qualified', position: 3, color: '#10B981' },
        { pipeline_id: pipelineId, name: 'Won',       position: 4, color: '#059669' },
        { pipeline_id: pipelineId, name: 'Lost',      position: 5, color: '#EF4444' },
      ];
      const { data: insertedStages, error: sErr } = await supabase
        .from('pipeline_stages')
        .insert(starterStages)
        .select('id, position')
        .order('position', { ascending: true });
      if (sErr || !insertedStages || insertedStages.length === 0) {
        result.errors.push(`Could not auto-create pipeline stages: ${sErr?.message || 'unknown error'}`);
        return result;
      }
      stageId = insertedStages[0].id;
    } else {
      pipelineId = (pipelines.find((p) => p.is_default) || pipelines[0]).id;
      const { data: stages } = await supabase
        .from('pipeline_stages')
        .select('id, position')
        .eq('pipeline_id', pipelineId)
        .order('position', { ascending: true })
        .limit(1);
      if (!stages || stages.length === 0) {
        // Pipeline exists but has no stages — backfill a starter set.
        const starterStages = [
          { pipeline_id: pipelineId, name: 'New Lead',  position: 1, color: '#3B82F6' },
          { pipeline_id: pipelineId, name: 'Contacted', position: 2, color: '#F59E0B' },
          { pipeline_id: pipelineId, name: 'Qualified', position: 3, color: '#10B981' },
          { pipeline_id: pipelineId, name: 'Won',       position: 4, color: '#059669' },
          { pipeline_id: pipelineId, name: 'Lost',      position: 5, color: '#EF4444' },
        ];
        const { data: insertedStages, error: sErr } = await supabase
          .from('pipeline_stages')
          .insert(starterStages)
          .select('id, position')
          .order('position', { ascending: true });
        if (sErr || !insertedStages || insertedStages.length === 0) {
          result.errors.push(`Pipeline ${pipelineId} has no stages and auto-create failed: ${sErr?.message || 'unknown'}`);
          return result;
        }
        stageId = insertedStages[0].id;
      } else {
        stageId = stages[0].id;
      }
    }
  }

  const total = rows.length;
  const skipDuplicates = settings && settings.skipDuplicates !== false;
  const updateExisting = settings && settings.updateExisting === true;

  // Pre-load existing leads by email for dedup
  const existingByEmail = new Map();
  if (skipDuplicates) {
    let page = 0;
    while (true) {
      const { data, error } = await supabase
        .from('leads')
        .select('id, email')
        .eq('user_id', userId)
        .range(page * 1000, (page + 1) * 1000 - 1);
      if (error || !data || data.length === 0) break;
      for (const l of data) {
        if (l.email) existingByEmail.set(l.email.toLowerCase().trim(), l.id);
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
      const company = pick(row, ['companyName', 'company', 'Company', 'Company Name', 'Business']);
      const source = pick(row, ['source', 'Source', 'Lead Source']);
      const notes = pick(row, ['notes', 'Notes', 'Note']);
      const value = toNumber(pick(row, ['leadValue', 'value', 'Value', 'Lead Value', 'Lead Price', 'Estimated Value']));
      const leadCost = toNumber(pick(row, ['leadCost', 'lead_cost', 'Lead Cost', 'CPL', 'Acquisition Cost', 'Cost']));
      const lastTaskDate = toDate(pick(row, ['lastTaskDate', 'last_task_date', 'Last Task Date', 'Last Activity', 'Last Contact']));
      const lastTaskTitle = pick(row, ['lastTaskTitle', 'last_task_title', 'Last Task Title']) || 'Imported activity';
      const nextTaskDate = toDate(pick(row, ['nextTaskDate', 'next_task_date', 'Next Task Date', 'Follow Up Date', 'Next Activity']));
      const nextTaskTitle = pick(row, ['nextTaskTitle', 'next_task_title', 'Next Task Title']) || 'Follow up';
      const address = pick(row, ['address', 'Address']);
      const serviceId = (() => {
        const raw = pick(row, ['leadServiceId', 'serviceId', 'service_id', 'Service ID']);
        return raw && /^\d+$/.test(raw) ? parseInt(raw, 10) : null;
      })();
      const createdAt = toDate(pick(row, ['createdAt', 'created_at', 'Created At', 'Created Date', 'Date Added', 'Lead Date']));

      if (!firstName && !lastName && !email && !phone) {
        result.errors.push(`Row ${i + 1}: Need at least one of first/last name, email, or phone`);
        continue;
      }

      const emailNorm = email ? email.toLowerCase().trim() : null;
      const existingId = emailNorm ? existingByEmail.get(emailNorm) : null;

      const payload = {
        user_id: userId,
        pipeline_id: pipelineId,
        stage_id: stageId,
        first_name: firstName || null,
        last_name: lastName || null,
        email: emailNorm,
        phone: phone || null,
        company: company || null,
        source: source || null,
        notes: notes || null,
        value,
        lead_cost: leadCost,
        address: address || null,
        service_id: serviceId,
      };
      if (createdAt) payload.created_at = createdAt;
      Object.keys(payload).forEach((k) => payload[k] === null && delete payload[k]);

      let leadId = null;
      if (existingId) {
        if (updateExisting) {
          const { error: upErr } = await supabase.from('leads').update(payload).eq('id', existingId);
          if (upErr) result.errors.push(`Row ${i + 1}: ${upErr.message}`);
          else { result.imported++; leadId = existingId; }
        } else {
          result.skipped++;
        }
      } else {
        const { data: inserted, error: insErr } = await supabase
          .from('leads')
          .insert(payload)
          .select('id')
          .single();
        if (insErr) result.errors.push(`Row ${i + 1}: ${insErr.message}`);
        else {
          result.imported++;
          leadId = inserted?.id || null;
          if (emailNorm) existingByEmail.set(emailNorm, true);
        }
      }

      // After the lead lands, insert lead_tasks rows for any mapped task
      // dates. Last task → completed (completed_at + due_date set).
      // Next task → pending (due_date in the future).
      if (leadId) {
        const taskRows = [];
        if (lastTaskDate) {
          taskRows.push({
            lead_id: leadId,
            user_id: userId,
            title: lastTaskTitle,
            due_date: lastTaskDate,
            completed_at: lastTaskDate,
            status: 'completed',
          });
        }
        if (nextTaskDate) {
          taskRows.push({
            lead_id: leadId,
            user_id: userId,
            title: nextTaskTitle,
            due_date: nextTaskDate,
            status: 'pending',
          });
        }
        if (taskRows.length > 0) {
          const { error: taskErr } = await supabase.from('lead_tasks').insert(taskRows);
          if (taskErr) {
            result.errors.push(`Row ${i + 1}: lead saved but task creation failed - ${taskErr.message}`);
          }
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
 * Import reviews into the unified `reviews` table.
 *
 * Optionally links each review to:
 *   - an existing customer (by reviewerEmail match)
 *   - an existing job (by reviewJobExternalId stored in jobs.contact_info._id /
 *     external_id, same lookup BK/ZB use for dedup)
 *
 * Dedups within import + against existing rows by (user_id, source, external_id).
 */
async function importReviews(supabase, userId, rows, settings, sendProgress) {
  const result = { imported: 0, skipped: 0, errors: [] };
  if (!Array.isArray(rows) || rows.length === 0) return result;

  const total = rows.length;
  const skipDuplicates = settings && settings.skipDuplicates !== false;
  const updateExisting = settings && settings.updateExisting === true;

  // Pre-load customers (email → id) for reviewer email matching
  const customerByEmail = new Map();
  {
    let page = 0;
    while (true) {
      const { data, error } = await supabase
        .from('customers')
        .select('id, email')
        .eq('user_id', userId)
        .range(page * 1000, (page + 1) * 1000 - 1);
      if (error || !data || data.length === 0) break;
      for (const c of data) {
        if (c.email) customerByEmail.set(c.email.toLowerCase().trim(), c.id);
      }
      if (data.length < 1000) break;
      page++;
    }
  }

  // Pre-load jobs by external ID (stored in contact_info._id / external_id)
  const jobByExternalId = new Map();
  {
    let page = 0;
    while (true) {
      const { data, error } = await supabase
        .from('jobs')
        .select('id, contact_info')
        .eq('user_id', userId)
        .not('contact_info', 'is', null)
        .range(page * 1000, (page + 1) * 1000 - 1);
      if (error || !data || data.length === 0) break;
      for (const j of data) {
        const ci = j.contact_info;
        if (ci && typeof ci === 'object') {
          const ext = ci.external_id || ci._id || ci.jobId;
          if (ext) jobByExternalId.set(String(ext), j.id);
        }
      }
      if (data.length < 1000) break;
      page++;
    }
  }

  // Pre-load existing reviews by (source + external_id) for dedup
  const existingByKey = new Map();
  if (skipDuplicates) {
    let page = 0;
    while (true) {
      const { data, error } = await supabase
        .from('reviews')
        .select('id, source, external_id')
        .eq('user_id', userId)
        .not('external_id', 'is', null)
        .range(page * 1000, (page + 1) * 1000 - 1);
      if (error || !data || data.length === 0) break;
      for (const r of data) {
        existingByKey.set(`${r.source}::${r.external_id}`, r.id);
      }
      if (data.length < 1000) break;
      page++;
    }
  }

  const KNOWN_SOURCES = ['google', 'yelp', 'thumbtack', 'booking_koala', 'bookingkoala', 'zenbooker', 'direct', 'manual'];
  const normalizeSource = (raw) => {
    if (!raw) return 'direct';
    const s = String(raw).toLowerCase().trim().replace(/\s+/g, '_');
    if (KNOWN_SOURCES.includes(s)) return s;
    if (s === 'bk') return 'booking_koala';
    if (s === 'zb' || s === 'zenbooker') return 'zenbooker';
    return s; // pass through unknown values
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const rating = toNumber(pick(row, ['rating', 'Rating', 'Stars', 'Score']));
      const ratingMax = toNumber(pick(row, ['ratingMax', 'rating_max', 'Rating Max', 'Out Of'])) || 5;
      const reviewText = pick(row, ['reviewText', 'review_text', 'Review', 'Review Text', 'Comment', 'Feedback']);
      const reviewerName = pick(row, ['reviewerName', 'reviewer_name', 'Reviewer', 'Reviewer Name', 'Author']);
      const reviewerEmail = pick(row, ['reviewerEmail', 'reviewer_email', 'Reviewer Email']);
      const sourceRaw = pick(row, ['reviewSource', 'source', 'Source', 'Platform', 'Channel']);
      const reviewDate = toDate(pick(row, ['reviewDate', 'review_date', 'Review Date', 'Reviewed At', 'Date']));
      const externalId = pick(row, ['reviewExternalId', 'external_id', 'External Review ID', 'Review ID']);
      const externalUrl = pick(row, ['reviewExternalUrl', 'external_url', 'Review URL', 'URL', 'Link']);
      const responseText = pick(row, ['reviewResponse', 'response_text', 'Response', 'Reply', 'Pro Response']);
      const responseDate = toDate(pick(row, ['reviewResponseDate', 'response_date', 'Response Date', 'Reply Date']));
      const jobExternalId = pick(row, ['reviewJobExternalId', 'job_external_id', 'Job ID', 'Booking ID']);

      const source = normalizeSource(sourceRaw);

      if (rating == null && !reviewText) {
        result.errors.push(`Row ${i + 1}: Need at least a rating or review text`);
        continue;
      }
      if (!sourceRaw) {
        result.errors.push(`Row ${i + 1}: Source is required (google / yelp / thumbtack / direct / …)`);
        continue;
      }

      // Dedup
      if (externalId && skipDuplicates) {
        const key = `${source}::${externalId}`;
        const existingId = existingByKey.get(key);
        if (existingId) {
          if (updateExisting) {
            // Fall through to update path below; we'll set existingId there
          } else {
            result.skipped++;
            continue;
          }
        }
      }

      // Resolve customer + job links
      const customerId = reviewerEmail
        ? customerByEmail.get(reviewerEmail.toLowerCase().trim()) || null
        : null;
      const jobId = jobExternalId
        ? jobByExternalId.get(String(jobExternalId)) || null
        : null;

      const payload = {
        user_id: userId,
        customer_id: customerId,
        job_id: jobId,
        rating,
        rating_max: ratingMax,
        review_text: reviewText || null,
        reviewer_name: reviewerName || null,
        reviewer_email: reviewerEmail ? reviewerEmail.toLowerCase().trim() : null,
        source,
        external_id: externalId || null,
        external_url: externalUrl || null,
        review_date: reviewDate,
        response_text: responseText || null,
        response_date: responseDate,
        status: 'published',
      };
      Object.keys(payload).forEach((k) => payload[k] === null && delete payload[k]);

      const dedupKey = externalId ? `${source}::${externalId}` : null;
      const existingId = dedupKey ? existingByKey.get(dedupKey) : null;

      if (existingId && updateExisting) {
        const { error: upErr } = await supabase.from('reviews').update(payload).eq('id', existingId);
        if (upErr) result.errors.push(`Row ${i + 1}: ${upErr.message}`);
        else result.imported++;
      } else if (!existingId) {
        const { data: inserted, error: insErr } = await supabase
          .from('reviews')
          .insert(payload)
          .select('id')
          .single();
        if (insErr) result.errors.push(`Row ${i + 1}: ${insErr.message}`);
        else {
          result.imported++;
          if (dedupKey && inserted) existingByKey.set(dedupKey, inserted.id);
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

const SUPPORTED_TYPES = ['customers', 'leads', 'jobs', 'team_members', 'services', 'territories', 'reviews'];

module.exports = {
  applyMapping,
  importTeamMembers,
  importServices,
  importTerritories,
  importLeads,
  importReviews,
  SUPPORTED_TYPES,
};
