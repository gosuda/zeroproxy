'use strict';
// Assemble runtime-prelude sources using the same lexicographical join order as scripts/build.mjs.
const fs = require('node:fs');
const path = require('node:path');

const MEMBRANE_DIR = path.resolve(__dirname, '../../web/membrane');

function preludeSource() {
  return fs.readdirSync(MEMBRANE_DIR)
    .filter(f => f.endsWith('.js'))
    .sort()
    .map(f => fs.readFileSync(path.join(MEMBRANE_DIR, f), 'utf8'))
    .join('\n');
}

module.exports = { preludeSource, MEMBRANE_DIR };
