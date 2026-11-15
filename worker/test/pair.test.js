import { describe, it, expect, beforeEach } from "vitest";
import { env, exports } from "cloudflare:workers";
import { sha256hex, hashPin } from "../src/crypto.js";

const PIN = "482913";
const call = (path, init = {}) => exports.default.fetch(new Request("http://x" + path, init));
const post = (body) =>
  call("/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function jwk() {
  const k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return crypto.subtle.exportKey("jwk", k.publicKey);
}
async function addCode(code, extra = {}) {
  await env.DB.prepare("INSERT INTO pairing_codes (code_hash,label,expires_at,used,pin_fails) VALUES (?,?,?,?,0)")
    .bind(await sha256hex(code), extra.label ?? "Telefon", extra.exp ?? Date.now() + 3600_000, extra.used ?? 0).run();
}
async function setPin() {
  const { hash, salt } = await hashPin(PIN);
  await env.DB.prepare("INSERT INTO settings (key,value) VALUES ('pin_hash',?),('pin_salt',?)").bind(hash, salt).run();
}
const count = async (t, w = "1=1") => (await env.DB.prepare(`SELECT COUNT(*) c FROM ${t} WHERE ${w}`).first()).c;

beforeEach(async () => {
  for (const t of ["settings", "devices", "pairing_codes", "challenges", "sessions", "pin_failures", "versions", "audit"])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  await setPin();
});

describe("POST /pair", () => {
  it("success: pending device, code used, contact text, audit", async () => {
    await addCode("c1", { label: "Telefon bunica" });
    const key = await jwk();
    const r = await post({ code: "c1", pin: PIN, publicKey: { ...key, ext: true, key_ops: ["verify"] } });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.status).toBe("pending");
    expect(b.contact).toBe("test contact");
    const d = await env.DB.prepare("SELECT * FROM devices WHERE id=?").bind(b.deviceId).first();
    expect(d.status).toBe("pending");
    expect(d.label).toBe("Telefon bunica");
    expect(JSON.parse(d.public_jwk)).toEqual({ kty: "EC", crv: "P-256", x: key.x, y: key.y });
    expect(await count("pairing_codes", "used=1")).toBe(1);
    const a = await env.DB.prepare("SELECT * FROM audit WHERE event='pair'").first();
    expect(a.ok).toBe(1);
    expect(a.device_id).toBe(b.deviceId);
  });
  it("reused, unknown and expired code -> same bad_code", async () => {
    await addCode("c1");
    await addCode("old", { exp: Date.now() - 1000 });
    const key = await jwk();
    expect((await post({ code: "c1", pin: PIN, publicKey: key })).status).toBe(200);
    for (const code of ["c1", "nope", "old"]) {
      const r = await post({ code, pin: PIN, publicKey: key });
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: "bad_code" });
    }
    expect(await count("devices")).toBe(1);
  });
  it("wrong pin -> 403 with left, 3rd burns the code", async () => {
    await addCode("c1");
    const key = await jwk();
    for (const left of [2, 1, 0]) {
      const r = await post({ code: "c1", pin: "000000", publicKey: key });
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: "bad_pin", left });
    }
    const r = await post({ code: "c1", pin: PIN, publicKey: key });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "bad_code" });
    expect(await count("pin_failures")).toBe(3);
    expect(await count("devices")).toBe(0);
    expect(await count("audit", "event='pin_fail'")).toBe(3);
  });
  it("correct PIN on the 3rd attempt still pairs", async () => {
    await addCode("c1");
    const key = await jwk();
    for (let i = 0; i < 2; i++) expect((await post({ code: "c1", pin: "000000", publicKey: key })).status).toBe(403);
    expect((await post({ code: "c1", pin: PIN, publicKey: key })).status).toBe(200);
  });
  it("concurrent wrong PINs: at most 3 tries per code", async () => {
    await addCode("c1");
    const key = await jwk();
    const rs = await Promise.all([1, 2, 3, 4, 5, 6].map(() => post({ code: "c1", pin: "000000", publicKey: key })));
    const st = rs.map((r) => r.status).sort();
    expect(st).toEqual([400, 400, 400, 403, 403, 403]);
    expect(await count("pairing_codes", "used=1")).toBe(1);
    expect(await count("pin_failures")).toBe(3);
  });
  it("20 failures in 24h set global_lock -> 423 without contact", async () => {
    const key = await jwk();
    for (let i = 0; i < 19; i++)
      await env.DB.prepare("INSERT INTO pin_failures (device_id,at) VALUES (NULL,?)").bind(Date.now() - 1000).run();
    await addCode("c1");
    await post({ code: "c1", pin: "000000", publicKey: key });
    expect(await count("settings", "key='global_lock'")).toBe(1);
    await addCode("c2");
    const r = await post({ code: "c2", pin: PIN, publicKey: key });
    expect(r.status).toBe(423);
    expect(await r.json()).toEqual({ error: "global_lock" });
    expect(await count("devices")).toBe(0);
  });
  it("failures older than 24h do not count", async () => {
    const key = await jwk();
    for (let i = 0; i < 19; i++)
      await env.DB.prepare("INSERT INTO pin_failures (device_id,at) VALUES (NULL,?)").bind(Date.now() - 25 * 3600_000).run();
    await addCode("c1");
    await post({ code: "c1", pin: "000000", publicKey: key });
    expect(await count("settings", "key='global_lock'")).toBe(0);
  });
  it("bad_key: wrong type/curve, private part, missing coords, non-object", async () => {
    await addCode("c1");
    const k = await jwk();
    for (const publicKey of [{ ...k, d: "x" }, { ...k, kty: "RSA" }, { ...k, crv: "P-384" }, { kty: "EC", crv: "P-256", x: k.x }, "str", null, [], undefined]) {
      const r = await post({ code: "c1", pin: PIN, publicKey });
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: "bad_key" });
    }
    expect(await count("pairing_codes", "used=0 AND pin_fails=0")).toBe(1);
  });
  it("malformed bodies never 500", async () => {
    const key = await jwk();
    for (const b of [null, [], 5, "x", {}, { code: 1, pin: PIN, publicKey: key }, { code: "c1", pin: 482913, publicKey: key }]) {
      await addCode("c1").catch(() => {});
      const r = await post(b);
      expect(r.status).toBeLessThan(500);
    }
    expect(await count("devices")).toBe(0);
  });
  it("no pin configured -> 503, attempts not consumed", async () => {
    await env.DB.prepare("DELETE FROM settings").run();
    await addCode("c1");
    const r = await post({ code: "c1", pin: PIN, publicKey: await jwk() });
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "not_configured" });
    expect(await count("pin_failures")).toBe(0);
    expect(await count("pairing_codes", "pin_fails=0 AND used=0")).toBe(1);
  });
  it("simultaneous requests: a code pairs only once", async () => {
    await addCode("c1");
    const key = await jwk();
    const rs = await Promise.all([1, 2, 3].map(() => post({ code: "c1", pin: PIN, publicKey: key })));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 400, 400]);
    expect(await count("devices")).toBe(1);
  });
});
