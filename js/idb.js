import { DB_NAME, DB_VERSION, STORE_SESSIONS, STORE_CHUNKS, STORE_BATCHES } from "./constants.js";

let _dbPromise = null;

export function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        db.createObjectStore(STORE_SESSIONS, { keyPath: "session_id" });
      }

      if (!db.objectStoreNames.contains(STORE_CHUNKS)) {
        // composite key: [session_id, chunk_index]
        const s = db.createObjectStore(STORE_CHUNKS, { keyPath: ["session_id", "chunk_index"] });
        s.createIndex("by_session", "session_id", { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_BATCHES)) {
        const s = db.createObjectStore(STORE_BATCHES, { keyPath: "id", autoIncrement: true });
        s.createIndex("by_session", "session_id", { unique: false });
        s.createIndex("by_session_chunk", ["session_id", "chunk_index"], { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  return _dbPromise;
}

export async function tx(storeNames, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeNames, mode);
    const stores = {};
    for (const name of storeNames) stores[name] = t.objectStore(name);

    let result;
    Promise.resolve()
      .then(() => fn(stores, t))
      .then((r) => { result = r; })
      .catch((e) => { try { t.abort(); } catch {} reject(e); });

    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("Transaction aborted"));
  });
}

export async function putSession(session) {
  return tx([STORE_SESSIONS], "readwrite", ({ sessions }) => reqToPromise(sessions.put(session)));
}

export async function getSession(sessionId) {
  return tx([STORE_SESSIONS], "readonly", ({ sessions }) => reqToPromise(sessions.get(sessionId)));
}

export async function getMostRecentUnfinishedSession() {
  // Scan sessions and return the newest active session by observed timestamp.
  return tx([STORE_SESSIONS], "readonly", ({ sessions }) => new Promise((resolve, reject) => {
    const req = sessions.openCursor();
    let best = null;
    let bestTs = -Infinity;
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve(best);
      const v = cur.value;
      if (v && v.active === 1) {
        const ts =
          Number(v.last_sample_ms) ||
          Date.parse(v.start_time_utc || "") ||
          -Infinity;
        if (ts > bestTs) {
          bestTs = ts;
          best = v;
        }
      }
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  }));
}

export async function enforceSingleActiveSession(activeSessionId) {
  return tx([STORE_SESSIONS], "readwrite", ({ sessions }) => new Promise((resolve, reject) => {
    const req = sessions.openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve();
      const v = cur.value || {};
      const shouldBeActive = v.session_id === activeSessionId ? 1 : 0;
      if ((v.active || 0) !== shouldBeActive) {
        cur.update({ ...v, active: shouldBeActive });
      }
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  }));
}

export async function putChunk(chunkMeta) {
  return tx([STORE_CHUNKS], "readwrite", ({ chunks }) => reqToPromise(chunks.put(chunkMeta)));
}

export async function getChunk(sessionId, chunkIndex) {
  return tx([STORE_CHUNKS], "readonly", ({ chunks }) => reqToPromise(chunks.get([sessionId, chunkIndex])));
}

export async function listChunks(sessionId) {
  return tx([STORE_CHUNKS], "readonly", ({ chunks }) => new Promise((resolve, reject) => {
    const idx = chunks.index("by_session");
    const req = idx.getAll(IDBKeyRange.only(sessionId));
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  }));
}

export async function addBatch(batch) {
  return tx([STORE_BATCHES], "readwrite", ({ batches }) => reqToPromise(batches.add(batch)));
}

export async function iterBatchesByChunk(sessionId, chunkIndex, onBatch) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction([STORE_BATCHES], "readonly");
    const store = t.objectStore(STORE_BATCHES);
    const idx = store.index("by_session_chunk");
    const range = IDBKeyRange.only([sessionId, chunkIndex]);
    const req = idx.openCursor(range);

    req.onsuccess = async () => {
      const cur = req.result;
      if (!cur) return resolve();
      try {
        await onBatch(cur.value);
        cur.continue();
      } catch (e) {
        try { t.abort(); } catch {}
        reject(e);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

export async function clearAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction([STORE_SESSIONS, STORE_CHUNKS, STORE_BATCHES], "readwrite");
    t.objectStore(STORE_SESSIONS).clear();
    t.objectStore(STORE_CHUNKS).clear();
    t.objectStore(STORE_BATCHES).clear();
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
