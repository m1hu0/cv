import { describe, it, expect, beforeEach } from "vitest";
import { env, exports } from "cloudflare:workers";
import { sha256hex, hashPin } from "../src/crypto.js";
import { requireSession } from "../src/auth.js";

const PIN = "482913";
const call = (path, init = {}) => exports.default.fetch(new Request("http://x" + path, init));
const post = (path, body, headers = {}) =>
  call(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const count = async (t, w = "1=1") => (await env.DB.prepare(`SELECT COUNT(*) c FROM ${t} WHERE ${w}`).first()).c;
const dev = (id) => env.DB.prepare("SELECT * FROM devices WHERE id=?").bind(id).first();

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function newKey() {
  const k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", k.publicKey);
  return { priv: k.privateKey, jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } };
}
const sign = async (priv, data) =>
  b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, new TextEncoder().encode(data)));

async function addDevice(id, status = "active", label = "Telefon") {
  const key = await newKey();
  await env.DB.prepare("INSERT INTO devices (id,label,public_jwk,status,created_at,last_seen) VALUES (?,?,?,?,?,?)")
    .bind(id, label, JSON.stringify(key.jwk), status, Date.now(), Date.now()).run();
  return { id, ...key };
}
async function challenge(d) {
  const r = await post("/challenge", { deviceId: d.id });
  expect(r.status).toBe(200);
  return (await r.json()).nonce;
}
async function login(d, pin = PIN, over = {}) {
  const nonce = over.nonce ?? (await challenge(d));
  const signature = over.signature ?? (await sign(over.priv ?? d.priv, nonce));
  return post("/login", { deviceId: d.id, nonce, signature, pin });
}
const bearer = (t) => new Request("http://x/p", { headers: { Authorization: "Bearer " + t } });

beforeEach(async () => {
  for (const t of ["settings", "devices", "pairing_codes", "challenges", "sessions", "pin_failures", "versions", "audit"])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  const { hash, salt } = await hashPin(PIN);
  await env.DB.prepare("INSERT INTO settings (key,value) VALUES ('pin_hash',?),('pin_salt',?)").bind(hash, salt).run();
});

describe("POST /challenge", () => {
  it("returns a nonce for active, pending and locked devices", async () => {
    for (const s of ["active", "pending", "locked"]) {
      const d = await addDevice("d-" + s, s);
      const r = await post("/challenge", { deviceId: d.id });
      expect(r.status).toBe(200);
      expect((await r.json()).nonce.length).toBeGreaterThanOrEqual(43);
    }
  });
  it("unknown, revoked and malformed -> 404 unknown_device", async () => {
    await addDevice("rev", "revoked");
    for (const b of [{ deviceId: "nope" }, { deviceId: "rev" }, { deviceId: 5 }, {}, null, [], "x"]) {
      const r = await post("/challenge", b);
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: "unknown_device" });
    }
  });
  it("purges expired challenges", async () => {
    const d = await addDevice("d1");
    await env.DB.prepare("INSERT INTO challenges (nonce,device_id,expires_at) VALUES ('old',?,?)").bind("d1", Date.now() - 1).run();
    await challenge(d);
    expect(await count("challenges", "nonce='old'")).toBe(0);
  });
});

describe("POST /login", () => {
  it("happy path: session works, counters reset, audited", async () => {
    const d = await addDevice("d1", "active", "Telefon bunica");
    await env.DB.prepare("UPDATE devices SET fails_window=2, fails_since_success=3, lock_level=1 WHERE id='d1'").run();
    const r = await login(d);
    expect(r.status).toBe(200);
    const { session } = await r.json();
    expect(typeof session).toBe("string");
    const row = await dev("d1");
    expect([row.fails_window, row.fails_since_success, row.lock_level]).toEqual([0, 0, 0]);
    expect(await count("challenges")).toBe(0);
    expect(await count("sessions")).toBe(1);
    expect(await requireSession(bearer(session), env)).toEqual({ deviceId: "d1", label: "Telefon bunica" });
    expect((await env.DB.prepare("SELECT ok FROM audit WHERE event='login'").first()).ok).toBe(1);
  });
  it("stores the session only as a hash", async () => {
    const d = await addDevice("d1");
    const { session } = await (await login(d)).json();
    expect(await count("sessions", `token_hash='${await sha256hex(session)}'`)).toBe(1);
    expect(await count("sessions", `token_hash='${session}'`)).toBe(0);
  });
  it("reused nonce -> 401", async () => {
    const d = await addDevice("d1");
    const nonce = await challenge(d);
    const signature = await sign(d.priv, nonce);
    expect((await post("/login", { deviceId: "d1", nonce, signature, pin: PIN })).status).toBe(200);
    expect((await post("/login", { deviceId: "d1", nonce, signature, pin: PIN })).status).toBe(401);
  });
  it("concurrent use of one nonce: only one wins", async () => {
    const d = await addDevice("d1");
    const nonce = await challenge(d);
    const signature = await sign(d.priv, nonce);
    const rs = await Promise.all([1, 2, 3, 4].map(() => post("/login", { deviceId: "d1", nonce, signature, pin: PIN })));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 401, 401, 401]);
    expect(await count("sessions")).toBe(1);
  });
  it("nonce older than 60 s -> 401", async () => {
    const d = await addDevice("d1");
    const nonce = await challenge(d);
    await env.DB.prepare("UPDATE challenges SET expires_at=?").bind(Date.now() - 1000).run();
    const r = await post("/login", { deviceId: "d1", nonce, signature: await sign(d.priv, nonce), pin: PIN });
    expect(r.status).toBe(401);
  });
  it("nonce issued to another device -> 401", async () => {
    const a = await addDevice("a");
    const b = await addDevice("b");
    const nonce = await challenge(a);
    const r = await post("/login", { deviceId: "b", nonce, signature: await sign(b.priv, nonce), pin: PIN });
    expect(r.status).toBe(401);
  });
  it("signature by another key -> bad_signature, no failure counted, PIN not evaluated", async () => {
    const d = await addDevice("d1");
    const other = await newKey();
    const r = await login(d, "000000", { priv: other.priv });
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: "bad_signature" });
    expect((await dev("d1")).fails_window).toBe(0);
    expect(await count("pin_failures")).toBe(0);
    expect(await count("sessions")).toBe(0);
  });
  it("malformed bodies and fields never 500", async () => {
    const d = await addDevice("d1");
    const nonce = await challenge(d);
    for (const b of [null, [], 5, "x", {}, { deviceId: "d1", nonce, signature: 1, pin: PIN },
      { deviceId: "d1", nonce, signature: "!!", pin: 5 }, { deviceId: "d1", nonce: 7, signature: "a", pin: PIN }]) {
      const r = await post("/login", b);
      expect(r.status).toBeLessThan(500);
      expect(r.status).toBeGreaterThanOrEqual(400);
    }
  });
  it("pending device -> pending with contact, after signature check", async () => {
    const d = await addDevice("d1", "pending");
    const r = await login(d);
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "pending", contact: "test contact" });
    const other = await newKey();
    const r2 = await login(d, PIN, { priv: other.priv });
    expect(await r2.json()).toEqual({ error: "bad_signature" });
  });
  it("wrong PIN -> 403 bad_pin with left, audited and counted", async () => {
    const d = await addDevice("d1");
    for (const left of [4, 3, 2]) {
      const r = await login(d, "000000");
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: "bad_pin", left });
    }
    expect(await count("pin_failures", "device_id='d1'")).toBe(3);
    expect(await count("audit", "event='login' AND ok=0")).toBe(3);
  });
  it("5 wrong -> 6th (even right) is 423 until ~15 min; second lock ~30 min", async () => {
    const d = await addDevice("d1");
    for (let i = 0; i < 5; i++) expect((await login(d, "000000")).status).toBe(403);
    let r = await login(d, PIN);
    expect(r.status).toBe(423);
    let b = await r.json();
    expect(b.error).toBe("locked");
    expect(b.contact).toBe("test contact");
    expect(Math.abs(b.until - (Date.now() + 15 * 60_000))).toBeLessThan(10_000);
    expect(await count("audit", "event='lock'")).toBe(1);

    // (fails_since_success reset so this 2nd lock is not also the 10-failure hard lock)
    await env.DB.prepare("UPDATE devices SET locked_until=?, fails_since_success=0 WHERE id='d1'").bind(Date.now() - 1).run();
    for (let i = 0; i < 5; i++) expect((await login(d, "000000")).status).toBe(403);
    r = await login(d, PIN);
    expect(r.status).toBe(423);
    b = await r.json();
    expect(Math.abs(b.until - (Date.now() + 30 * 60_000))).toBeLessThan(10_000);
  });
  it("10 wrong since success -> status locked; right PIN refused until admin unlock", async () => {
    const d = await addDevice("d1");
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 5; i++) expect((await login(d, "000000")).status).toBe(403);
      await env.DB.prepare("UPDATE devices SET locked_until=? WHERE id='d1' AND status='active'").bind(Date.now() - 1).run();
    }
    expect((await dev("d1")).status).toBe("locked");
    const r = await login(d, PIN);
    expect(r.status).toBe(423);
    const b = await r.json();
    expect(b.error).toBe("locked");
    expect(b.until).toBeUndefined();

    const u = await call("/admin/devices/d1/unlock", { method: "POST", headers: { Authorization: "Bearer " + env.ADMIN_TOKEN } });
    expect(u.status).toBe(200);
    expect((await login(d, PIN)).status).toBe(200);
  });
  it("a device revoked while its wrong-PIN request is in flight stays revoked", async () => {
    const d = await addDevice("d1");
    await env.DB.prepare("UPDATE devices SET fails_window=4, fails_since_success=9 WHERE id='d1'").run();
    const real = env.DB;
    // revoke lands between the attempt reservation and the lock UPDATE
    env.DB = new Proxy(real, {
      get(t, k) {
        if (k !== "prepare") return typeof t[k] === "function" ? t[k].bind(t) : t[k];
        return (sql) => {
          const st = t.prepare(sql);
          if (!/SET locked_until = \?, lock_level/.test(sql)) return st;
          return { bind: (...a) => ({ run: async () => {
            await t.prepare("UPDATE devices SET status='revoked' WHERE id='d1'").run();
            return st.bind(...a).run();
          } }) };
        };
      },
    });
    try {
      expect((await login(d, "000000")).status).toBe(403);
    } finally {
      env.DB = real;
    }
    expect((await dev("d1")).status).toBe("revoked");
  });
  it("success resets the failure streak", async () => {
    const d = await addDevice("d1");
    for (let i = 0; i < 4; i++) await login(d, "000000");
    expect((await login(d, PIN)).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await login(d, "000000")).status).toBe(403);
    expect((await login(d, PIN)).status).toBe(200);
  });
  it("20 wrong across 3 devices -> global_lock with contact", async () => {
    const ds = [await addDevice("a"), await addDevice("b"), await addDevice("c")];
    let last;
    for (let n = 0; n < 20; n++) {
      const d = ds[n % 3];
      await env.DB.prepare("UPDATE devices SET locked_until=0 WHERE id=?").bind(d.id).run();
      last = await login(d, "000000");
    }
    expect(last.status).toBe(423);
    expect(await last.json()).toEqual({ error: "global_lock", contact: "test contact" });
    await env.DB.prepare("UPDATE devices SET locked_until=0").run();
    const r = await login(ds[0], PIN);
    expect(r.status).toBe(423);
    expect((await r.json()).error).toBe("global_lock");
  });
  it("concurrent wrong PINs cannot escape the lockout", async () => {
    const d = await addDevice("d1");
    const nonces = [];
    for (let i = 0; i < 8; i++) nonces.push(await challenge(d));
    const rs = await Promise.all(nonces.map(async (nonce) =>
      post("/login", { deviceId: "d1", nonce, signature: await sign(d.priv, nonce), pin: "000000" })));
    const st = rs.map((r) => r.status);
    const bad = st.filter((s) => s === 403).length;
    expect(bad).toBeLessThanOrEqual(5);
    expect(st.filter((s) => s === 423).length).toBe(8 - bad);
    const row = await dev("d1");
    expect(row.locked_until).toBeGreaterThan(Date.now());
    expect(row.lock_level).toBe(1);
    expect(await count("pin_failures", "device_id='d1'")).toBeLessThanOrEqual(5);
  });
  it("no CONTACT_TEXT -> contact key omitted", async () => {
    const d = await addDevice("d1", "pending");
    const nonce = await challenge(d);
    const signature = await sign(d.priv, nonce);
    const saved = env.CONTACT_TEXT;
    try {
      delete env.CONTACT_TEXT;
      const r = await post("/login", { deviceId: "d1", nonce, signature, pin: PIN });
      expect(await r.json()).toEqual({ error: "pending" });
    } finally {
      env.CONTACT_TEXT = saved;
    }
  });
});

describe("sessions", () => {
  async function mkSession() {
    const d = await addDevice("d1");
    const { session } = await (await login(d)).json();
    return { d, session };
  }
  it("missing, malformed and unknown bearer -> 401 session", async () => {
    for (const req of [new Request("http://x/p"), bearer("nope"), new Request("http://x/p", { headers: { Authorization: "Basic abc" } }), bearer("")]) {
      const r = await requireSession(req, env);
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: "session" });
    }
  });
  it("idle 31 min -> 401 and row deleted", async () => {
    const { session } = await mkSession();
    await env.DB.prepare("UPDATE sessions SET last_used=?").bind(Date.now() - 31 * 60_000).run();
    expect((await requireSession(bearer(session), env)).status).toBe(401);
    expect(await count("sessions")).toBe(0);
  });
  it("8 h old but active -> 401", async () => {
    const { session } = await mkSession();
    await env.DB.prepare("UPDATE sessions SET created_at=?").bind(Date.now() - 8 * 3600_000 - 1000).run();
    expect((await requireSession(bearer(session), env)).status).toBe(401);
    expect(await count("sessions")).toBe(0);
  });
  it("use bumps last_used and device last_seen", async () => {
    const { session } = await mkSession();
    await env.DB.prepare("UPDATE sessions SET last_used=?").bind(Date.now() - 20 * 60_000).run();
    await env.DB.prepare("UPDATE devices SET last_seen=1").run();
    expect(await requireSession(bearer(session), env)).toMatchObject({ deviceId: "d1" });
    const s = await env.DB.prepare("SELECT last_used FROM sessions").first();
    expect(Date.now() - s.last_used).toBeLessThan(5000);
    expect((await dev("d1")).last_seen).toBeGreaterThan(1);
  });
  it("session of a locked or revoked device is rejected", async () => {
    const { session } = await mkSession();
    for (const s of ["locked", "revoked"]) {
      await env.DB.prepare("UPDATE devices SET status=?").bind(s).run();
      expect((await requireSession(bearer(session), env)).status).toBe(401);
    }
  });
  it("POST /logout deletes the session", async () => {
    const { session } = await mkSession();
    const r = await call("/logout", { method: "POST", headers: { Authorization: "Bearer " + session } });
    expect(r.status).toBe(200);
    expect(await count("sessions")).toBe(0);
    expect((await requireSession(bearer(session), env)).status).toBe(401);
  });
});
