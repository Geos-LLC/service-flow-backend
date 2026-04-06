require('dotenv').config();
const { supabase } = require('./supabase');

const userId = 2;

async function zbFetch(apiKey, path, params = {}) {
  const url = new URL('https://api.zenbooker.com/v1' + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + apiKey } });
  if (!res.ok) throw new Error('ZB API ' + res.status);
  return res.json();
}

const STATUS_MAP = { 'scheduled': 'confirmed', 'en-route': 'in-progress', 'started': 'in-progress', 'complete': 'completed' };

function zbDateToLocal(isoDate, timezone) {
  if (!isoDate) return null;
  try {
    const d = new Date(isoDate);
    const opts = { timeZone: timezone || 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
    const parts = new Intl.DateTimeFormat('en-CA', opts).formatToParts(d);
    const get = (type) => (parts.find(p => p.type === type) || {}).value || '00';
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
  } catch { return isoDate.replace('T', ' ').replace(/\.000Z$/, ''); }
}

async function run() {
  const { data: user } = await supabase.from('users').select('zenbooker_api_key').eq('id', userId).single();
  const apiKey = user.zenbooker_api_key;

  // 1. Territories
  console.log('\n=== TERRITORIES ===');
  const tData = await zbFetch(apiKey, '/territories', { limit: 100 });
  for (const zb of tData.results) {
    const { data, error } = await supabase.from('territories').insert({ user_id: userId, name: zb.name, zenbooker_id: zb.id }).select('id');
    console.log(error ? `FAIL ${zb.name}: ${JSON.stringify(error)}` : `OK ${zb.name} → ${data[0].id}`);
  }

  // 2. Services
  console.log('\n=== SERVICES ===');
  const sData = await zbFetch(apiKey, '/services', { limit: 100 });
  for (const zb of sData.results) {
    const { data, error } = await supabase.from('services').insert({
      user_id: userId, name: zb.name, description: (zb.description || '').substring(0, 1000),
      price: parseFloat(zb.base_price) || 0, duration: zb.base_duration || 0,
      zenbooker_id: zb.service_id || zb.id, is_active: true
    }).select('id');
    console.log(error ? `FAIL ${zb.name}: ${JSON.stringify(error)}` : `OK ${zb.name} → ${data[0].id}`);
  }

  // 3. Team Members
  console.log('\n=== TEAM MEMBERS ===');
  const tmData = await zbFetch(apiKey, '/team_members', { limit: 100 });
  let tmOk = 0, tmFail = 0;
  for (const zb of tmData.results) {
    const parts = (zb.name || '').split(' ');
    const { data, error } = await supabase.from('team_members').insert({
      user_id: userId, first_name: parts[0] || '', last_name: parts.slice(1).join(' ') || '',
      email: zb.email || '', phone: zb.phone || null, zenbooker_id: zb.id
    }).select('id');
    if (error) { console.error(`FAIL ${zb.name}: ${JSON.stringify(error)}`); tmFail++; }
    else { tmOk++; }
  }
  console.log(`Team: ${tmOk} OK, ${tmFail} FAILED`);

  // 4. Customers (first 20)
  console.log('\n=== CUSTOMERS (20) ===');
  const cData = await zbFetch(apiKey, '/customers', { limit: 20 });
  let cOk = 0, cFail = 0;
  for (const zb of cData.results) {
    const parts = (zb.name || '').split(' ');
    const { data, error } = await supabase.from('customers').insert({
      user_id: userId, first_name: parts[0] || '', last_name: parts.slice(1).join(' ') || '',
      email: zb.email || null, phone: zb.phone || null, zenbooker_id: zb.id
    }).select('id');
    if (error) { console.error(`FAIL ${zb.name}: ${JSON.stringify(error)}`); cFail++; }
    else { cOk++; }
  }
  console.log(`Customers: ${cOk} OK, ${cFail} FAILED`);

  // 5. Jobs (5)
  console.log('\n=== JOBS (5) ===');
  const { data: dbCust } = await supabase.from('customers').select('id, zenbooker_id').eq('user_id', userId).not('zenbooker_id', 'is', null);
  const { data: dbSvc } = await supabase.from('services').select('id, name, zenbooker_id').eq('user_id', userId).not('zenbooker_id', 'is', null);
  const { data: dbTm } = await supabase.from('team_members').select('id, zenbooker_id').eq('user_id', userId).not('zenbooker_id', 'is', null);
  const { data: dbTerr } = await supabase.from('territories').select('id, zenbooker_id').eq('user_id', userId).not('zenbooker_id', 'is', null);
  const custMap = {}; (dbCust || []).forEach(c => custMap[c.zenbooker_id] = c.id);
  const tmMap = {}; (dbTm || []).forEach(t => tmMap[t.zenbooker_id] = t.id);
  const tMap = {}; (dbTerr || []).forEach(t => tMap[t.zenbooker_id] = t.id);

  const jData = await zbFetch(apiKey, '/jobs', { limit: 5, sort_order: 'descending' });
  for (const zb of jData.results) {
    const inv = zb.invoice || {};
    const addr = zb.service_address || {};
    const status = zb.canceled ? 'cancelled' : (STATUS_MAP[(zb.status || '').toLowerCase()] || 'pending');
    const provider = zb.assigned_providers?.[0];
    const mapped = {
      user_id: userId,
      customer_id: zb.customer?.id ? custMap[zb.customer.id] || null : null,
      service_name: zb.service_name || '',
      team_member_id: provider?.id ? tmMap[provider.id] || null : null,
      territory_id: zb.territory?.id ? tMap[zb.territory.id] || null : null,
      status,
      scheduled_date: zbDateToLocal(zb.start_date, zb.timezone),
      duration: zb.estimated_duration_seconds ? Math.round(zb.estimated_duration_seconds / 60) : 0,
      service_address_street: addr.line1 || addr.formatted || '',
      service_address_city: addr.city || '',
      service_address_state: addr.state || '',
      service_address_zip: addr.postal_code || '',
      price: parseFloat(inv.subtotal) || 0,
      service_price: parseFloat(inv.subtotal) || 0,
      total: parseFloat(inv.total) || 0,
      total_amount: parseFloat(inv.total) || 0,
      taxes: parseFloat(inv.tax_amount) || 0,
      discount: parseFloat(inv.discount_amount) || 0,
      tip_amount: parseFloat(inv.tip) || 0,
      invoice_status: inv.status === 'paid' ? 'paid' : (inv.status === 'unpaid' ? 'invoiced' : 'draft'),
      is_recurring: zb.recurring === true,
      zenbooker_id: zb.id,
    };
    const { data, error } = await supabase.from('jobs').insert(mapped).select('id');
    if (error) console.error(`FAIL job ${zb.customer?.name}: ${JSON.stringify(error)}`);
    else console.log(`OK job: ${zb.customer?.name} ${mapped.scheduled_date} → ${data[0].id} [${status}]`);
  }

  // Cleanup
  console.log('\n=== CLEANUP ===');
  await supabase.from('jobs').delete().eq('user_id', userId);
  await supabase.from('customers').delete().eq('user_id', userId);
  await supabase.from('team_members').delete().eq('user_id', userId);
  await supabase.from('services').delete().eq('user_id', userId);
  await supabase.from('territories').delete().eq('user_id', userId);
  console.log('Done');
  process.exit(0);
}

run().catch(e => { console.error('\nCRASH:', e.message, e.stack); process.exit(1); });
