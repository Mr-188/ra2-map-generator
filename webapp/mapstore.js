// The hand-off between the generator page and the map editor.
//
// The editor is a separate page, so the generated map (and the generator's
// per-cell sidecar) has to survive the navigation.  IndexedDB is the right
// place: it stores the bytes without base64/string inflation, it is same-origin
// and it survives a reload of either tab.  The extracted asset tree is already
// in OPFS (worker.js), so the editor reuses that instead of asking for the game
// directory again.
//
// One session is kept: the last map handed to the editor.  `generated` is the
// untouched generator output (for 还原), `current` is what the editor shows.
// Pure browser code; no node imports.

const DB_NAME = 'mg-map-editor';
const DB_VERSION = 1;
const STORE = 'sessions';
const KEY = 'current';

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB 不可用')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('无法打开 IndexedDB'));
  });
}

function run(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let request;
    try { request = fn(store); } catch (err) { db.close(); reject(err); return; }
    tx.oncomplete = () => {
      db.close();
      // IDBRequest.result is the stored value for get(); put() resolves to its key
      // (unused).  Resolving the REQUEST object itself was the bug: every session
      // then read back with undefined fields and looked "empty".
      resolve(request && 'result' in request ? request.result : request);
    };
    tx.onerror = () => { db.close(); reject(tx.error || new Error('IndexedDB 事务失败')); };
    tx.onabort = () => { db.close(); reject(tx.error || new Error('IndexedDB 事务中止')); };
  }));
}

/** Stores a freshly generated map for the editor. */
export async function saveGenerated({ bytes, cells, name, theater, code }) {
  if (!bytes || !bytes.byteLength) throw new Error('没有地图字节可保存');
  const now = Date.now();
  await run('readwrite', (store) => store.put({
    id: KEY,
    name: name || 'out.map',
    theater: Number(theater) || 0,
    code: code || '',
    generated: new Uint8Array(bytes),
    current: new Uint8Array(bytes),
    cells: cells ? new Uint8Array(cells) : null,
    savedAt: now,
    editedAt: now,
  }, KEY));
}

/** The current session, or null when the editor was opened with nothing. */
export async function loadSession() {
  const got = await run('readonly', (store) => store.get(KEY));
  return got || null;
}

/** Replaces the working bytes (called after each edit, debounced by the page). */
export async function saveCurrent(bytes) {
  if (!bytes || !bytes.byteLength) return;
  const session = await loadSession();
  if (!session) return;
  session.current = new Uint8Array(bytes);
  session.editedAt = Date.now();
  await run('readwrite', (store) => store.put(session, KEY));
}

/** Discards the edits: current goes back to the generator's bytes. */
export async function resetCurrent() {
  const session = await loadSession();
  if (!session) return null;
  session.current = new Uint8Array(session.generated);
  session.editedAt = Date.now();
  await run('readwrite', (store) => store.put(session, KEY));
  return session.current;
}
