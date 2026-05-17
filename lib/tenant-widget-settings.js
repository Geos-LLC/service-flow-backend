'use strict';

// Tenant Widget Settings — per-tenant on/off + tunables for public
// embeddable widgets (currently: past-cleanings map).
//
// Backed by `tenant_widget_settings` (migration 046). Reads are intentionally
// permissive: if a tenant has no row, the widget is OFF by default so we
// never accidentally publish data for a tenant that hasn't opted in.

const { resolveTenantSettings } = require('./public-past-cleanings-map');

// Default in-memory shape if the tenant has no settings row.
function defaultSettings() {
  return resolveTenantSettings({
    past_cleanings_enabled: false,
    past_cleanings_max_pins: 250,
    past_cleanings_range: '365d',
  });
}

// Fetch normalized widget settings for a tenant. `supabaseClient` is
// passed in so this module stays free of any singleton dependency
// (which makes unit-testing trivial).
async function getPastCleaningsSettings(supabaseClient, tenantId) {
  if (!supabaseClient || tenantId == null) return defaultSettings();
  const { data, error } = await supabaseClient
    .from('tenant_widget_settings')
    .select('past_cleanings_enabled, past_cleanings_max_pins, past_cleanings_range')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error || !data) return defaultSettings();
  return resolveTenantSettings(data);
}

module.exports = {
  defaultSettings,
  getPastCleaningsSettings,
};
