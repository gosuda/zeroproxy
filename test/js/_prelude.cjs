'use strict';
// runtime-prelude 소스는 web/membrane/*.js concat 조각이다 (REFACTOR.md §3.3).
// 테스트가 머지된 IIFE 전체를 읽어야 하므로 빌드와 같은 규칙 — 사전순 파일명,
// '\n' join — 으로 조립한다. scripts/build.mjs 와 반드시 같은 순서.
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
