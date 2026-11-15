import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.location = { hostname: "localhost", pathname: "/cv/", search: "", hash: "" };
let replaced = null;
globalThis.history = { replaceState: (s, t, url) => { replaced = url; } };

const api = await import("../api.js");
const dev = await import("../device.js");

// Minimal in-memory IndexedDB with the calls device.js makes.
function fakeIdb({ failOpen = false } = {}) {
  const data = new Map();
  return {
    data,
    open() {
      const req = {};
      queueMicrotask(() => {
        if (failOpen) { req.error = new Error("idb broken"); return req.onerror && req.onerror(); }
        req.result = {
          close() {},
          transaction() {
            const tx = {};
            tx.objectStore = () => ({
              get: (k) => ({ result: data.get(k) }),
              put: (v, k) => { data.set(k, v); return { result: k }; },
              delete: (k) => { data.delete(k); return { result: undefined }; },
            });
            queueMicrotask(() => tx.oncomplete && tx.oncomplete());
            return tx;
          },
        };
        req.onsuccess && req.onsuccess();
      });
      return req;
    },
  };
}

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

beforeEach(() => {
  store.clear();
  replaced = null;
  api.setAuthLostHandler(null);
  location.hash = "";
});

test("API_BASE is localhost worker on localhost", () => {
  assert.equal(api.API_BASE, "http://localhost:8787");
});

test("request retries once after session 401 when handler resolves", async () => {
  let calls = 0, handled = 0;
  const auths = [];
  globalThis.fetch = async (url, opts) => {
    calls++;
    auths.push(opts.headers.Authorization);
    return calls === 1 ? json(401, { error: "session" }) : json(200, { ok: 1 });
  };
  api.setAuthLostHandler(async () => { handled++; });
  assert.deepEqual(await api.request("GET", "/cv"), { ok: 1 });
  assert.equal(calls, 2);
  assert.equal(handled, 1);
});

test("request does not loop on a second 401", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return json(401, { error: "session" }); };
  api.setAuthLostHandler(async () => {});
  await assert.rejects(api.request("GET", "/cv"), (e) => e.code === "session" && e.status === 401);
  assert.equal(calls, 2);
});

test("concurrent 401s share one handler call", async () => {
  let handled = 0;
  const seen = new Set();
  globalThis.fetch = async (url) => {
    if (!seen.has(url)) { seen.add(url); return json(401, { error: "session" }); }
    return json(200, { u: url });
  };
  api.setAuthLostHandler(async () => { handled++; await new Promise((r) => setTimeout(r, 10)); });
  await Promise.all([api.request("GET", "/a"), api.request("GET", "/b"), api.request("GET", "/c")]);
  assert.equal(handled, 1);
});

test("fetch rejection becomes offline", async () => {
  globalThis.fetch = async () => { throw new TypeError("net"); };
  await assert.rejects(api.request("GET", "/cv"), (e) => e.code === "offline");
});

test("bad_pin surfaces code and left", async () => {
  globalThis.fetch = async () => json(403, { error: "bad_pin", left: 3 });
  await assert.rejects(api.request("POST", "/pair", {}), (e) => e.code === "bad_pin" && e.left === 3 && e.status === 403);
});

test("purgeLegacy removes keys and strips #key=", () => {
  localStorage.setItem("cv-editor-data-v1", "x");
  localStorage.setItem("cv-editor-gemini-key", "y");
  location.hash = "#key=AIza123";
  api.purgeLegacy();
  assert.equal(localStorage.getItem("cv-editor-data-v1"), null);
  assert.equal(localStorage.getItem("cv-editor-gemini-key"), null);
  assert.equal(replaced, "/cv/");
});

test("purgeLegacy keeps #pair= hashes", () => {
  location.hash = "#pair=abc";
  api.purgeLegacy();
  assert.equal(replaced, null);
});

test("signNonce signature verifies", async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  dev._setKeyPairForTest(pair);
  const sig = await dev.signNonce("nonce-123");
  const raw = Uint8Array.from(atob(sig.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  assert.equal(raw.length, 64);
  assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, raw, new TextEncoder().encode("nonce-123")));
});

test("login without device id throws no_device", async () => {
  await assert.rejects(api.login("123456"), (e) => e.code === "no_device");
});

test("login: challenge, sign, session used as bearer; pair stores deviceId", async () => {
  globalThis.indexedDB = fakeIdb();
  dev._setKeyPairForTest(null);
  const log = [];
  globalThis.fetch = async (url, opts) => {
    log.push([url, opts]);
    if (url.endsWith("/pair")) return json(200, { deviceId: "d1", status: "pending" });
    if (url.endsWith("/challenge")) return json(200, { nonce: "n1" });
    if (url.endsWith("/login")) return json(200, { session: "S" });
    return json(200, { id: null, data: null });
  };
  await api.pair("code", "123456");
  assert.equal(dev.getDeviceId(), "d1");
  assert.equal(JSON.parse(log[0][1].body).publicKey.kty, "EC");
  await api.login("123456");
  const body = JSON.parse(log.at(-1)[1].body);
  assert.equal(body.deviceId, "d1");
  assert.equal(body.nonce, "n1");
  assert.equal(body.pin, "123456");
  assert.ok(body.signature);
  await api.getCv();
  assert.equal(log.at(-1)[1].headers.Authorization, "Bearer S");
});

test("failed pair does not store deviceId", async () => {
  globalThis.indexedDB = fakeIdb();
  dev._setKeyPairForTest(null);
  globalThis.fetch = async () => json(400, { error: "bad_code" });
  await assert.rejects(api.pair("c", "1"), (e) => e.code === "bad_code");
  assert.equal(dev.getDeviceId(), null);
  assert.equal(await dev.hasDeviceKey(), false);
});

test("failed re-pair (bad PIN, dead link, offline) leaves the old key and device id working", async () => {
  const idb = (globalThis.indexedDB = fakeIdb());
  dev._setKeyPairForTest(null);
  globalThis.fetch = async () => json(200, { deviceId: "old", status: "pending" });
  await api.pair("code1", "123456");
  const oldPair = idb.data.get("main");
  assert.ok(oldPair);
  const fails = [
    () => json(403, { error: "bad_pin", left: 2 }),
    () => json(400, { error: "bad_code" }),
    () => { throw new TypeError("net"); },
  ];
  for (const fail of fails) {
    globalThis.fetch = async () => fail();
    await assert.rejects(api.pair("code2", "000000"));
    assert.equal(dev.getDeviceId(), "old");
    assert.equal(idb.data.get("main"), oldPair);
  }
  // the old key still signs for the old device id
  const log = [];
  globalThis.fetch = async (url, opts) => {
    log.push(JSON.parse(opts.body));
    return url.endsWith("/challenge") ? json(200, { nonce: "n" }) : json(200, { session: "S2" });
  };
  await api.login("123456");
  assert.equal(log[1].deviceId, "old");
  const raw = Uint8Array.from(atob(log[1].signature.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, oldPair.publicKey, raw, new TextEncoder().encode("n")));
});

test("successful re-pair replaces key and device id", async () => {
  const idb = (globalThis.indexedDB = fakeIdb());
  dev._setKeyPairForTest(null);
  globalThis.fetch = async () => json(200, { deviceId: "old", status: "pending" });
  await api.pair("code1", "123456");
  const oldPair = idb.data.get("main");
  globalThis.fetch = async () => json(200, { deviceId: "new", status: "pending" });
  await api.pair("code2", "123456");
  assert.equal(dev.getDeviceId(), "new");
  assert.notEqual(idb.data.get("main"), oldPair);
});

test("createDeviceKeyPair does not store anything", async () => {
  const idb = (globalThis.indexedDB = fakeIdb());
  const { pair, publicJwk } = await dev.createDeviceKeyPair();
  assert.ok(pair.privateKey);
  assert.equal(publicJwk.kty, "EC");
  assert.equal(idb.data.size, 0);
});

test("hasDeviceKey: absent -> false; storage error -> throws storage", async () => {
  dev._setKeyPairForTest(null);
  globalThis.indexedDB = fakeIdb();
  assert.equal(await dev.hasDeviceKey(), false);
  globalThis.indexedDB = fakeIdb({ failOpen: true });
  await assert.rejects(dev.hasDeviceKey(), (e) => e.code === "storage");
  delete globalThis.indexedDB;
  await assert.rejects(dev.hasDeviceKey(), (e) => e.code === "storage");
});

test("logout with an expired session does not run the auth-lost handler and clears the session", async () => {
  globalThis.fetch = async (url) =>
    url.endsWith("/challenge") ? json(200, { nonce: "n" }) : url.endsWith("/login") ? json(200, { session: "S" }) : json(401, { error: "session" });
  dev._setKeyPairForTest(await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]));
  localStorage.setItem("cv-device-id", "d1");
  await api.login("123456");
  let handled = 0;
  api.setAuthLostHandler(async () => { handled++; });
  await api.logout();
  assert.equal(handled, 0);
  const seen = [];
  globalThis.fetch = async (url, opts) => { seen.push(opts.headers.Authorization); return json(200, {}); };
  await api.getCv();
  assert.equal(seen[0], undefined);
});

test("logout ignores network errors", async () => {
  globalThis.fetch = async () => { throw new TypeError("net"); };
  await api.logout();
});

test("requests carry a timeout: 45 s for /translate, 20 s otherwise", async () => {
  const orig = AbortSignal.timeout;
  const seen = [];
  AbortSignal.timeout = (ms) => { seen.push(ms); return orig.call(AbortSignal, ms); };
  const signals = [];
  globalThis.fetch = async (url, opts) => { signals.push(opts.signal); return json(200, {}); };
  try {
    await api.getCv();
    await api.translate({ kind: "personal", input: {} });
  } finally { AbortSignal.timeout = orig; }
  assert.deepEqual(seen, [20000, 45000]);
  assert.ok(signals.every((x) => x instanceof AbortSignal));
});

test("a timed-out request rejects with code timeout", async () => {
  globalThis.fetch = async () => { throw new DOMException("The operation timed out.", "TimeoutError"); };
  await assert.rejects(api.request("GET", "/cv"), (e) => e.code === "timeout");
});

test("saveCv and restoreVersion send the {id, rev} base", async () => {
  const bodies = [];
  globalThis.fetch = async (url, opts) => { bodies.push(JSON.parse(opts.body)); return json(200, { id: 1, rev: 2, latest: true }); };
  await api.saveCv({ personal: {}, work: [] }, { id: 1, rev: 1 }, "auto");
  await api.restoreVersion(3, { id: 1, rev: 2 });
  assert.deepEqual(bodies[0].basedOn, { id: 1, rev: 1 });
  assert.deepEqual(bodies[1], { basedOn: { id: 1, rev: 2 } });
});

test("sync-throwing handler does not wedge later auth-lost handling", async () => {
  let n = 0;
  globalThis.fetch = async () => (++n <= 1 ? json(401, { error: "session" }) : json(200, { ok: 1 }));
  api.setAuthLostHandler(() => { throw new Error("boom"); });
  await assert.rejects(api.request("GET", "/cv"));
  let handled = 0;
  api.setAuthLostHandler(async () => { handled++; });
  n = 0;
  assert.deepEqual(await api.request("GET", "/cv"), { ok: 1 });
  assert.equal(handled, 1);
});

test("null handler: 401 rejects with session; later handler is called", async () => {
  let n = 0;
  globalThis.fetch = async () => (n++ < 2 ? json(401, { error: "session" }) : json(200, { ok: 2 }));
  api.setAuthLostHandler(null);
  await assert.rejects(api.request("GET", "/cv"), (e) => e.code === "session");
  let handled = 0;
  api.setAuthLostHandler(async () => { handled++; });
  n = 1;
  assert.deepEqual(await api.request("GET", "/cv"), { ok: 2 });
  assert.equal(handled, 1);
});
