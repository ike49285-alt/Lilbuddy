// save.js — the "continue" slot: the whole world kept in IndexedDB so a
// visit picks up exactly where the last one left off. Every call is
// wrapped: where storage isn't available the page runs normally and says
// saving is off.

const DB = 'headwaters';
const STORE = 'worlds';
const SLOT = 'continue';

function open() {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB, 1);
    } catch (e) {
      reject(e);
      return;
    }
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('storage blocked'));
  });
}

async function tx(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      const req = fn(store);
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('aborted'));
    });
  } finally {
    db.close();
  }
}

export async function saveWorld(state) {
  await tx('readwrite', (store) => store.put({ savedAt: Date.now(), state }, SLOT));
}

export async function loadWorld() {
  return tx('readonly', (store) => store.get(SLOT));
}

export async function storageWorks() {
  try {
    await tx('readonly', (store) => store.count());
    return true;
  } catch {
    return false;
  }
}
