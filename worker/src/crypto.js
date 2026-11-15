// WebCrypto-only helpers. No secrets are logged or stored here.
const enc = new TextEncoder();
const dec = new TextDecoder();

const PBKDF2_ITERATIONS = 100000; // Workers' WebCrypto maximum

function bytesToB64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
const toB64url = (bytes) => bytesToB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function fromB64url(s) {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  return b64ToBytes(t);
}

export function randomToken(bytes) {
  return toB64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256hex(s) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function safeEqual(a, b) {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function pbkdf2(pin, salt) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPin(pin, saltB64) {
  const saltBytes = saltB64 ? b64ToBytes(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const hash = bytesToB64(await pbkdf2(pin, saltBytes));
  return { hash, salt: bytesToB64(saltBytes) };
}

export async function verifyPin(pin, hash, salt) {
  try {
    const { hash: h } = await hashPin(pin, salt);
    return safeEqual(h, hash);
  } catch {
    return false;
  }
}

function aesKey(keyB64, usage) {
  return crypto.subtle.importKey("raw", b64ToBytes(keyB64), "AES-GCM", false, [usage]);
}

export async function encryptJson(obj, keyB64) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(keyB64, "encrypt");
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(obj)));
  return { iv: bytesToB64(iv), blob: bytesToB64(new Uint8Array(ct)) };
}

export async function decryptJson(iv, blob, keyB64) {
  const key = await aesKey(keyB64, "decrypt");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(iv) }, key, b64ToBytes(blob));
  return JSON.parse(dec.decode(pt));
}

export async function verifySignature(publicJwk, data, sigB64url) {
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      publicJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      fromB64url(sigB64url),
      enc.encode(data),
    );
  } catch {
    return false;
  }
}
