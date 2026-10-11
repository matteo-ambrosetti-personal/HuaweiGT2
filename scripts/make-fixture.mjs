// Write a synthetic, AES-256 encrypted Huawei export for tests and demos.
// Usage: node scripts/make-fixture.mjs [days] [out.zip]
// Password: test1234

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ZipWriter, Uint8ArrayWriter, TextReader, configure } from '@zip.js/zip.js';
import { generateExport } from '../src/lib/sample/generate.js';

configure({ useWebWorkers: false });

const days = Number(process.argv[2] || 120);
const out = resolve(process.argv[3] || 'test/fixtures/out/huawei-export-test.zip');
export const FIXTURE_PASSWORD = 'test1234';

const { files, plan } = generateExport({ days, seed: 42, gpsEvery: 2 });
const writer = new ZipWriter(new Uint8ArrayWriter(), { password: FIXTURE_PASSWORD, encryptionStrength: 3 });
for (const f of files) await writer.add(f.name, new TextReader(f.text));
const data = await writer.close();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, data);
writeFileSync(out.replace(/\.zip$/, '.plan.json'), JSON.stringify({
  days,
  workouts: plan.workouts.length,
  firstDay: Object.keys(plan.days)[0],
  lastDay: Object.keys(plan.days).at(-1),
  totalSteps: Object.values(plan.days).reduce((s, d) => s + d.steps, 0),
}, null, 2));
console.log(`Wrote ${out} (${(data.length / 1e6).toFixed(1)} MB, ${files.length} files, ${plan.workouts.length} workouts)`);
