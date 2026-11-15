// Device key (ECDSA P-256, non-extractable, kept in IndexedDB) and device id helpers.
const DB_NAME = "cv-device";
const STORE = "keys";
const KEY_ID = "main";
const LS_DEVICE = "cv-device-id";

let testPair = null;

export function _setKeyPairForTest(pair) {
  testPair = pair;
}

export function b64url(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

const loadPair = () => idb("readonly", (s) => s.get(KEY_ID));
const storePair = (pair) => idb("readwrite", (s) => s.put(pair, KEY_ID));
const deletePair = () => idb("readwrite", (s) => s.delete(KEY_ID));

// New key pair in memory only; stored with storeDeviceKey once the server accepted it,
// so a failed re-pair leaves the old key working.
export async function createDeviceKeyPair() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { pair, publicJwk: await crypto.subtle.exportKey("jwk", pair.publicKey) };
}

export async function storeDeviceKey(pair) {
  try {
    await storePair(pair);
  } catch {
    throw { code: "storage" };
  }
  testPair = null;
}

// false: no key on this device. Throws {code:"storage"} when storage cannot be read
// (a transient error must never be taken as "not paired").
export async function hasDeviceKey() {
  if (testPair) return true;
  let pair;
  try {
    pair = await loadPair();
  } catch {
    throw { code: "storage" };
  }
  return !!pair;
}

export async function signNonce(nonce) {
  let pair = testPair;
  if (!pair) {
    try {
      pair = await loadPair();
    } catch {
      throw { code: "storage" };
    }
  }
  if (!pair) throw { code: "no_key" };
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(nonce));
  return b64url(sig);
}

export async function forgetDevice() {
  testPair = null;
  try {
    await deletePair();
  } catch {}
  try {
    localStorage.removeItem(LS_DEVICE);
  } catch {}
}

export function getDeviceId() {
  try {
    return localStorage.getItem(LS_DEVICE);
  } catch {
    return null;
  }
}

export function setDeviceId(id) {
  localStorage.setItem(LS_DEVICE, id);
}

export function platform() {
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "ios";
  if (/Android/.test(ua)) return "android";
  return "other";
}

export function isStandalone() {
  return !!navigator.standalone || (typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches);
}
