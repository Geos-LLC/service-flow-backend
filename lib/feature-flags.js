'use strict';

// Identity unification feature flags — all default OFF while Phase A is landing.
// Flip per-flag via env or per-user overrides in future phases.
//
// Reading order: env override → default (false).
// Env values accepted as truthy: 1, true, TRUE, yes, on.

function envBool(name) {
  const v = process.env[name];
  if (v === undefined || v === null) return null;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

const FLAGS = {
  // Phase A: resolver available for call but nothing wired to it yet.
  IDENTITY_RESOLVER_AVAILABLE: 'IDENTITY_RESOLVER_AVAILABLE',
  // Phase B/C/D per-source rewiring gates.
  IDENTITY_RESOLVER_LEADBRIDGE: 'IDENTITY_RESOLVER_LEADBRIDGE',
  IDENTITY_RESOLVER_OPENPHONE:  'IDENTITY_RESOLVER_OPENPHONE',
  IDENTITY_RESOLVER_ZENBOOKER:  'IDENTITY_RESOLVER_ZENBOOKER',
  // Phase C: conditional lead creation from OpenPhone (incl. LB-recovery path).
  OPENPHONE_CONDITIONAL_LEAD_CREATION: 'OPENPHONE_CONDITIONAL_LEAD_CREATION',
  // Phase E: backfill job gate.
  IDENTITY_BACKFILL_ENABLED: 'IDENTITY_BACKFILL_ENABLED',
  // Phase F: replace 5-bucket classifier UI with identity-centric reporting.
  IDENTITY_REPORTING_UI: 'IDENTITY_REPORTING_UI',
};

function isEnabled(flag) {
  if (!Object.values(FLAGS).includes(flag)) throw new Error(`Unknown flag: ${flag}`);
  const env = envBool(flag);
  if (env !== null) return env;
  return false;
}

function snapshot() {
  const out = {};
  for (const name of Object.values(FLAGS)) out[name] = isEnabled(name);
  return out;
}

module.exports = { FLAGS, isEnabled, snapshot };
