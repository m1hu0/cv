// Client for the CV Worker. The session token lives in this module's memory only.
import { signNonce, getDeviceId, setDeviceId, createDeviceKeyPair, storeDeviceKey } from "./device.js";

export const API_BASE =
  typeof location !== "undefined" && location.hostname === "localhost"
    ? "http://localhost:8787"
    : "https://cv-api.mihnea2006.workers.dev";

const TIMEOUT_MS = 20000;
const TRANSLATE_TIMEOUT_MS = 45000; // Worker tries up to 3 models, 20 s each at worst

let session = null;
let authLostHandler = null;
let handlerInFlight = null;

export function setAuthLostHandler(fn) {
  authLostHandler = fn;
}

function runAuthLost() {
  if (!handlerInFlight) {
    const p = Promise.resolve().then(() => authLostHandler && authLostHandler());
    handlerInFlight = p;
    const clear = () => { if (handlerInFlight === p) handlerInFlight = null; };
    p.then(clear, clear);
  }
  return handlerInFlight;
}

const timeoutSignal = (ms) =>
  typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
const isTimeout = (e) => !!e && (e.name === "TimeoutError" || e.name === "AbortError");

async function send(method, path, body, token = session) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = "Bearer " + token;
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: timeoutSignal(path === "/translate" ? TRANSLATE_TIMEOUT_MS : TIMEOUT_MS),
    });
  } catch (e) {
    throw { code: isTimeout(e) ? "timeout" : "offline" };
  }
  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { res, data };
}

export async function request(method, path, body) {
  if (typeof path !== "string" || path[0] !== "/" || path[1] === "/") throw { code: "bad_path" };
  let { res, data } = await send(method, path, body);
  if (res.status === 401 && data && data.error === "session") {
    await runAuthLost();
    ({ res, data } = await send(method, path, body));
  }
  if (!res.ok) throw { ...(data || {}), code: (data && data.error) || "server", status: res.status };
  return data;
}

// Pairs with a fresh key pair. The stored key and device id change only after the
// server accepted the new key: a wrong PIN, dead link or no internet keeps the old pairing.
export async function pair(code, pin) {
  const { pair: keyPair, publicJwk } = await createDeviceKeyPair();
  const r = await request("POST", "/pair", { code, pin, publicKey: publicJwk });
  await storeDeviceKey(keyPair);
  setDeviceId(r.deviceId);
  return r;
}

export async function login(pin) {
  const deviceId = getDeviceId();
  if (!deviceId) throw { code: "no_device" };
  const { nonce } = await request("POST", "/challenge", { deviceId });
  const signature = await signNonce(nonce);
  const r = await request("POST", "/login", { deviceId, nonce, signature, pin });
  session = r.session;
  return r;
}

// Never asks for the PIN again: an expired session is simply dropped.
export async function logout() {
  const token = session;
  session = null;
  if (!token) return;
  try {
    await send("POST", "/logout", undefined, token);
  } catch {}
}

export const getCv = () => request("GET", "/cv");
export const saveCv = (data, basedOn, kind) => request("POST", "/cv", { data, basedOn, kind });
export const listVersions = () => request("GET", "/versions");
export const getVersion = (id) => request("GET", "/versions/" + encodeURIComponent(id));
export const restoreVersion = (id, basedOn) =>
  request("POST", "/versions/" + encodeURIComponent(id) + "/restore", { basedOn });
export const translate = (payload) => request("POST", "/translate", payload);

export function purgeLegacy() {
  try {
    localStorage.removeItem("cv-editor-data-v1");
    localStorage.removeItem("cv-editor-gemini-key");
  } catch {}
  if (location.hash.includes("key=")) {
    history.replaceState(null, "", location.pathname + location.search);
  }
}
