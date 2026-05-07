'use strict';

// Re-export surface for the ZB cleanup library.
//
// READ-ONLY by design. None of the modules in this directory write to the
// database. The CLI (scripts/zb-cleanup-classify.js) wraps the supabase
// client in a guard that throws on any non-select op.

module.exports = {
  ...require('./classifier'),
  ...require('./tenant-resolver'),
  ...require('./window-detector'),
  ...require('./risk-score'),
  ...require('./csv'),
  ...require('./checksums'),
  ...require('./provenance'),
};
