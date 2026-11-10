// Tiny IndexedDB wrapper. Shared by the service worker and the viewer page
// (same extension origin => same database).
let dbPromise = null;

function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("dom-recorder", 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      const snaps = db.createObjectStore("snapshots", { keyPath: "id", autoIncrement: true });
      snaps.createIndex("key", "key");
      db.createObjectStore("html", { keyPath: "id" });
      db.createObjectStore("events", { keyPath: "id", autoIncrement: true });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

const getDB = () => (dbPromise ||= open());
const req = (r) =>
  new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
const done = (tx) =>
  new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  });

export async function addSnapshot(meta, html, force) {
  const db = await getDB();
  if (!force && meta.key) {
    const n = await req(db.transaction("snapshots").objectStore("snapshots").index("key").count(meta.key));
    if (n) return { duplicate: true };
  }
  const tx = db.transaction(["snapshots", "html"], "readwrite");
  const id = await req(tx.objectStore("snapshots").add(meta));
  tx.objectStore("html").put({ id, html });
  await done(tx);
  return { id };
}

export async function addEvents(list) {
  if (!list.length) return;
  const db = await getDB();
  const tx = db.transaction("events", "readwrite");
  list.forEach((e) => tx.objectStore("events").add(e));
  await done(tx);
}

export async function count(store) {
  const db = await getDB();
  return req(db.transaction(store).objectStore(store).count());
}

export async function getAll(store) {
  const db = await getDB();
  return req(db.transaction(store).objectStore(store).getAll());
}

export async function getHtml(id) {
  const db = await getDB();
  const row = await req(db.transaction("html").objectStore("html").get(id));
  return row ? row.html : "";
}

export async function deleteSnapshots(ids) {
  const db = await getDB();
  const tx = db.transaction(["snapshots", "html"], "readwrite");
  ids.forEach((id) => {
    tx.objectStore("snapshots").delete(id);
    tx.objectStore("html").delete(id);
  });
  await done(tx);
}

export async function clearAll() {
  const db = await getDB();
  const tx = db.transaction(["snapshots", "html", "events"], "readwrite");
  ["snapshots", "html", "events"].forEach((s) => tx.objectStore(s).clear());
  await done(tx);
}
