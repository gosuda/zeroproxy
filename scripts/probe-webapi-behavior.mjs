import fs from 'node:fs';
import { writeJSONFile } from './json-output.mjs';

const manifest = JSON.parse(fs.readFileSync('test/fixtures/webapi/bridge-surface.json', 'utf8'));
const probes = new Map();
for (const entry of manifest.entries) {
  for (const probe of entry.probes || []) {
    const list = probes.get(probe) || [];
    list.push(entry.name);
    probes.set(probe, list);
  }
}
const report = {
  version: 1,
  probes: [...probes]
    .map(([name, entries]) => ({ name, entries: entries.sort() }))
    .sort((a, b) => a.name.localeCompare(b.name)),
};
const out = process.argv[2] || 'test/fixtures/webapi/webapi-behavior-probes.json';
writeJSONFile(out, report);
console.log(JSON.stringify({ probes: report.probes.length }, null, 2));
