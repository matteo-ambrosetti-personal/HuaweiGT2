// Main-thread side of importing: opens the (AES-encrypted) Huawei ZIP with
// zip.js, streams each relevant file's decompressed bytes to the parser worker
// with back-pressure, and resolves with the parsed dataset fragment.

import { classifyEntry, entryOrder } from '../lib/huawei/entries.js';

/* global WORKER_SOURCE */
const MAX_IN_FLIGHT = 8;

export class ImportError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function makeWorker() {
  const blob = new Blob([WORKER_SOURCE], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  const w = new Worker(url);
  URL.revokeObjectURL(url);
  return w;
}

export class Importer {
  constructor() {
    this.worker = makeWorker();
    this.seq = 0;
    this.fileSeq = 0;
    this.inFlight = 0;
    this.waiters = [];
    this.pending = null;
    this.worker.onmessage = (e) => this.onMessage(e.data);
    this.worker.onerror = (e) => {
      this.pending?.reject(new ImportError('worker', e.message || 'The parser stopped unexpectedly.'));
      this.pending = null;
    };
  }

  onMessage(m) {
    if (m.type === 'ack') {
      this.inFlight--;
      while (this.waiters.length && this.inFlight < MAX_IN_FLIGHT) this.waiters.shift()();
    } else if (m.type === 'done') {
      this.pending?.resolve(m);
      this.pending = null;
    } else if (m.type === 'error') {
      this.pending?.reject(new ImportError(m.code || 'parse', m.message));
      this.pending = null;
    }
  }

  expectResult() {
    return new Promise((resolve, reject) => { this.pending = { resolve, reject }; });
  }

  sendChunk(id, chunk) {
    const copy = chunk.slice();
    this.worker.postMessage({ type: 'chunk', id, seq: ++this.seq, bytes: copy }, [copy.buffer]);
    this.inFlight++;
    if (this.inFlight < MAX_IN_FLIGHT) return undefined;
    return new Promise((r) => this.waiters.push(r));
  }

  /** Build the sample dataset in the worker. */
  sample(endDate) {
    const p = this.expectResult();
    this.worker.postMessage({ type: 'sample', endDate, days: 150 });
    return p;
  }

  /** Convert a downloaded OpenStreetMap file into map documents ({chunks, cells, bbox, counts}). */
  mapFile(text, areas) {
    const p = this.expectResult();
    this.worker.postMessage({ type: 'basemap', text, areas: areas || [] });
    return p.then((m) => m.basemap);
  }

  /** Parse GPX/TCX/CSV texts as a given source. */
  activityFiles(files, source) {
    const p = this.expectResult();
    this.worker.postMessage({ type: 'activity-files', files, source });
    return p;
  }

  /**
   * Import a Huawei export from picked files: one ZIP, or extracted JSON files.
   * @param {File[]} files
   * @param {{password?: string, onProgress?: (p: {done: number, total: number, file: string}) => void}} opts
   */
  async importExport(files, { password, onProgress = () => {} } = {}) {
    const zips = files.filter((f) => /\.zip$/i.test(f.name));
    const jsons = files.filter((f) => classifyEntry(f.webkitRelativePath || f.name) && !/\.zip$/i.test(f.name));
    if (!zips.length && !jsons.length) {
      throw new ImportError('no_files', 'No Huawei export files found. Pick the ZIP from Huawei, or the extracted folder.');
    }
    const result = this.expectResult();
    this.worker.postMessage({ type: 'start' });
    const progress = { done: 0, total: 0, file: '' };
    try {
      for (const z of zips) await this.readZip(z, password, progress, onProgress);
      if (jsons.length) {
        progress.total += jsons.reduce((s, f) => s + f.size, 0);
        for (const f of jsons.sort((a, b) => entryOrder(classifyEntry(a.name)) - entryOrder(classifyEntry(b.name)))) {
          await this.streamFile(f, classifyEntry(f.webkitRelativePath || f.name), progress, onProgress);
        }
      }
    } catch (err) {
      this.pending = null;
      this.worker.terminate();
      this.worker = makeWorker();
      this.worker.onmessage = (e) => this.onMessage(e.data);
      this.inFlight = 0;
      this.waiters = [];
      throw err;
    }
    this.worker.postMessage({ type: 'finish' });
    return result;
  }

  async readZip(blob, password, progress, onProgress) {
    const zip = window.zip;
    if (!zip) throw new ImportError('no_zip', 'The ZIP reader did not load. Check your connection and reload the page.');
    zip.configure({ useWebWorkers: false });
    const reader = new zip.ZipReader(new zip.BlobReader(blob), password ? { password } : {});
    let entries;
    try {
      entries = await reader.getEntries();
    } catch (err) {
      throw new ImportError('bad_zip', `This file could not be opened as a ZIP (${err.message}).`);
    }
    const encrypted = entries.some((e) => e.encrypted);
    if (encrypted && !password) {
      await reader.close();
      throw new ImportError('password_required', 'This export is password-protected. Enter the password you chose when requesting it.');
    }
    const relevant = entries
      .filter((e) => !e.directory && classifyEntry(e.filename))
      .sort((a, b) => entryOrder(classifyEntry(a.filename)) - entryOrder(classifyEntry(b.filename)));
    if (!relevant.length) {
      await reader.close();
      throw new ImportError('no_health_files', 'This ZIP has no Huawei Health files in it. Did you pick the right export?');
    }
    progress.total += relevant.filter((e) => classifyEntry(e.filename) !== 'zip').reduce((s, e) => s + (e.uncompressedSize || 0), 0);
    for (const entry of relevant) {
      const kind = classifyEntry(entry.filename);
      if (kind === 'zip') {
        const inner = await entry.getData(new zip.BlobWriter(), password ? { password } : {});
        await this.readZip(inner, password, progress, onProgress);
        continue;
      }
      const id = ++this.fileSeq;
      const name = entry.filename.split('/').pop();
      progress.file = name;
      this.worker.postMessage({ type: 'begin', id, kind, name });
      const base = progress.done;
      try {
        await entry.getData(
          new WritableStream({ write: (chunk) => this.sendChunk(id, chunk) }),
          {
            ...(password ? { password } : {}),
            onprogress: (loaded) => {
              progress.done = base + loaded;
              onProgress({ ...progress });
            },
          },
        );
      } catch (err) {
        await reader.close().catch(() => {});
        if (/password/i.test(String(err.message))) {
          throw new ImportError('bad_password', 'Wrong password. Use the password you set when requesting the export from Huawei.');
        }
        throw new ImportError('read_failed', `Could not read ${name} (${err.message}).`);
      }
      progress.done = base + (entry.uncompressedSize || 0);
      onProgress({ ...progress });
      this.worker.postMessage({ type: 'end', id });
    }
    await reader.close();
  }

  async streamFile(file, kind, progress, onProgress) {
    const id = ++this.fileSeq;
    progress.file = file.name;
    this.worker.postMessage({ type: 'begin', id, kind, name: file.name });
    const reader = file.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      progress.done += value.byteLength;
      onProgress({ ...progress });
      await this.sendChunk(id, value);
    }
    this.worker.postMessage({ type: 'end', id });
  }
}
