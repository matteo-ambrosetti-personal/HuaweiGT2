// Parser worker: receives decompressed file chunks, streams them through the
// JSON element splitter and the Huawei accumulators, and returns a dataset
// fragment. Also builds the sample dataset and parses GPX/TCX/CSV files.

import { JsonArrayStream, parseLenient, parseArrayText } from '../lib/json-stream.js';
import { createHuaweiImporter } from '../lib/huawei/index.js';
import { classifyEntry } from '../lib/huawei/entries.js';
import { generateExport } from '../lib/sample/generate.js';
import { parseActivityFile, parseDailyCsv } from '../lib/healthsync.js';
import { emptyDataset, mergeDataset } from '../lib/model.js';

let imp = null;
const open = new Map();

function fail(err) {
  self.postMessage({ type: 'error', message: String(err?.message || err) });
}

self.onmessage = (e) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'start':
        imp = createHuaweiImporter();
        open.clear();
        break;
      case 'begin': {
        const f = { kind: m.kind, name: m.name, decoder: new TextDecoder('utf-8'), errors: 0, bytes: 0, stream: null };
        f.stream = new JsonArrayStream((src) => {
          let v;
          try {
            v = parseLenient(src);
          } catch {
            f.errors++;
            return;
          }
          imp.add(f.kind, v);
        });
        open.set(m.id, f);
        break;
      }
      case 'chunk': {
        const f = open.get(m.id);
        if (f) {
          f.bytes += m.bytes.byteLength;
          try {
            f.stream.push(f.decoder.decode(m.bytes, { stream: true }));
          } catch (err) {
            f.errors++;
            f.failed = String(err.message || err);
          }
        }
        self.postMessage({ type: 'ack', seq: m.seq });
        break;
      }
      case 'end': {
        const f = open.get(m.id);
        if (f) {
          try {
            f.stream.push(f.decoder.decode());
            f.stream.end();
          } catch (err) {
            f.failed = String(err.message || err);
          }
          imp.noteFile(f.name, f.kind, { elements: f.stream.count, errors: f.errors, bytes: f.bytes, failed: f.failed });
          open.delete(m.id);
        }
        break;
      }
      case 'finish': {
        const { dataset, diag } = imp.finish();
        imp = null;
        self.postMessage({ type: 'done', dataset, diag });
        break;
      }
      case 'sample': {
        const { files } = generateExport({ days: m.days || 150, endDate: m.endDate, seed: 11, gpsEvery: 4 });
        const s = createHuaweiImporter();
        for (const f of files) {
          const kind = classifyEntry(f.name);
          if (!kind || kind === 'zip') continue;
          s.noteFile(f.name, kind, parseArrayText(f.text, (v) => s.add(kind, v)));
        }
        const { dataset, diag } = s.finish();
        self.postMessage({ type: 'done', dataset, diag, sample: true });
        break;
      }
      case 'activity-files': {
        // [{name, text, id}] GPX/TCX/CSV → fragment for `source`
        const frag = emptyDataset();
        const out = emptyDataset();
        const report = { parsed: 0, skipped: [] };
        for (const file of m.files) {
          const lower = file.name.toLowerCase();
          if (lower.endsWith('.csv')) {
            const { days, nights, columns } = parseDailyCsv(file.text);
            if (!Object.keys(days).length && !Object.keys(nights).length) {
              report.skipped.push({ name: file.name, reason: 'no recognised columns', columns: Object.keys(columns) });
              continue;
            }
            Object.assign(frag.days, days);
            Object.assign(frag.nights, nights);
            report.parsed++;
            continue;
          }
          const res = parseActivityFile(file.name, file.text, file.id);
          if (!res) {
            report.skipped.push({ name: file.name, reason: 'not a GPX/TCX activity' });
            continue;
          }
          res.workout.source = m.source;
          res.workout.sources = [m.source];
          frag.workouts[res.workout.id] = res.workout;
          if (res.track) frag.tracks[res.workout.id] = res.track;
          report.parsed++;
        }
        mergeDataset(out, frag, m.source);
        self.postMessage({ type: 'done', dataset: out, diag: report });
        break;
      }
      default:
        break;
    }
  } catch (err) {
    fail(err);
  }
};
