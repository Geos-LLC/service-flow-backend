'use strict';

// SHA256 file hashing. Used so summary.json carries integrity hashes for
// every output artifact, defending against tampering during the soak window
// and giving operators a single comparison point across re-runs.

const crypto = require('crypto');
const fs = require('fs');

function sha256OfFile(absPath) {
  const buf = fs.readFileSync(absPath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256OfString(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

module.exports = { sha256OfFile, sha256OfString };
