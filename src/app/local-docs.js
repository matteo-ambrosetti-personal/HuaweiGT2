// Document storage on the device, with the same small interface as the
// artifact's db (collection(path).limit(n).get(), doc(path).get/set/delete),
// so the store's month/track/map layout works unchanged in the app:
//   FsDocs  — one JSON file per document in the app's private files (Android).
//   IdbDocs — IndexedDB, for the app opened in a browser.
// A collection lists only its direct children: "a/b" holds "a/b/meta" but
// not "a/b/tracks/items/x".

const snapshot = (id, body) => ({ id, exists: body !== undefined, data: () => body });

/**
 * Files under `root` in the app's private data directory. `fs` is the
 * Capacitor Filesystem plugin (or a stand-in with the same calls).
 */
export class FsDocs {
  constructor(fs, { root = 'gt2', directory = 'DATA' } = {}) {
    this.fs = fs;
    this.root = root;
    this.directory = directory;
  }

  file(path) {
    return `${this.root}/${path}.json`;
  }

  async read(path) {
    try {
      const res = await this.fs.readFile({ path: this.file(path), directory: this.directory, encoding: 'utf8' });
      return JSON.parse(res.data);
    } catch (e) {
      if (isMissing(e)) return undefined;
      throw e;
    }
  }

  collection(path) {
    const self = this;
    return {
      limit() { return this; },
      async get() {
        let files = [];
        try {
          files = (await self.fs.readdir({ path: `${self.root}/${path}`, directory: self.directory })).files || [];
        } catch (e) {
          if (!isMissing(e)) throw e;
        }
        const names = files
          .filter((f) => (typeof f === 'string' ? true : f.type !== 'directory'))
          .map((f) => (typeof f === 'string' ? f : f.name))
          .filter((n) => n.endsWith('.json'));
        const docs = [];
        for (const name of names) {
          const id = name.slice(0, -5);
          const body = await self.read(`${path}/${id}`);
          if (body !== undefined) docs.push(snapshot(id, body));
        }
        return { docs };
      },
    };
  }

  doc(path) {
    const self = this;
    return {
      async get() {
        return snapshot(path.split('/').pop(), await self.read(path));
      },
      async set(body) {
        await self.fs.writeFile({ path: self.file(path), directory: self.directory, encoding: 'utf8', data: JSON.stringify(body), recursive: true });
      },
      async delete() {
        try {
          await self.fs.deleteFile({ path: self.file(path), directory: self.directory });
        } catch (e) {
          if (!isMissing(e)) throw e;
        }
      },
    };
  }
}

/** Capacitor reports a missing file or folder with an error message, not a code we can rely on. */
function isMissing(e) {
  return /not exist|no such|not found|ENOENT|doesn't exist/i.test(String(e?.message || e)) || e?.code === 'OS-PLUG-FILE-0008';
}

/** IndexedDB: one object store of documents keyed by path. */
export class IdbDocs {
  constructor(name = 'gt2-logbook') {
    this.name = name;
    this.dbp = null;
  }

  open() {
    this.dbp ||= new Promise((resolve, reject) => {
      const req = indexedDB.open(this.name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('docs');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbp;
  }

  async tx(mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const t = db.transaction('docs', mode);
      const store = t.objectStore('docs');
      let result;
      const req = fn(store);
      if (req) req.onsuccess = () => { result = req.result; };
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || Object.assign(new Error('Storage transaction aborted'), { code: 'quota_exceeded' }));
    });
  }

  collection(path) {
    const self = this;
    return {
      limit() { return this; },
      async get() {
        const prefix = `${path}/`;
        const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
        const db = await self.open();
        const docs = await new Promise((resolve, reject) => {
          const out = [];
          const req = db.transaction('docs', 'readonly').objectStore('docs').openCursor(range);
          req.onsuccess = () => {
            const c = req.result;
            if (!c) return resolve(out);
            const id = String(c.key).slice(prefix.length);
            if (!id.includes('/')) out.push(snapshot(id, c.value));
            c.continue();
          };
          req.onerror = () => reject(req.error);
        });
        return { docs };
      },
    };
  }

  doc(path) {
    const self = this;
    return {
      async get() {
        return snapshot(path.split('/').pop(), await self.tx('readonly', (s) => s.get(path)));
      },
      async set(body) {
        await self.tx('readwrite', (s) => s.put(body, path));
      },
      async delete() {
        await self.tx('readwrite', (s) => s.delete(path));
      },
    };
  }
}
