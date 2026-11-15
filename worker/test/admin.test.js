import { describe, it, expect, beforeEach } from "vitest";
import { env, exports } from "cloudflare:workers";
import { sha256hex } from "../src/crypto.js";
import worker from "../src/index.js";

const AUTH = { Authorization: "Bearer test-admin-token-0123456789abcdef0123456789" };
const call = (path, init = {}) => exports.default.fetch(new Request("http://x" + path, init));
const post = (path, body, headers = AUTH) =>
  call(path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
const get = (path, headers = AUTH) => call(path, { headers });

async function addDevice(id, status, extra = {}) {
  await env.DB.prepare(
    "INSERT INTO devices (id,label,status,fails_window,fails_since_success,lock_level,locked_until,created_at,last_seen) VALUES (?,?,?,?,?,?,?,?,?)",
  ).bind(id, "L" + id, status, extra.fw ?? 0, extra.fs ?? 0, extra.ll ?? 0, extra.lu ?? 0, 1000, 2000).run();
}
const status = async (id) => (await env.DB.prepare("SELECT status FROM devices WHERE id=?").bind(id).first())?.status;

beforeEach(async () => {
  for (const t of ["settings", "devices", "pairing_codes", "challenges", "sessions", "pin_failures", "versions", "audit"])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
});

describe("admin auth", () => {
  it("missing bearer -> 401 + audit row", async () => {
    const r = await get("/admin/devices", {});
    expect(r.status).toBe(401);
    const row = await env.DB.prepare("SELECT * FROM audit WHERE event='admin_auth'").first();
    expect(row.ok).toBe(0);
  });
  it("wrong bearer -> 401", async () => {
    const r = await get("/admin/devices", { Authorization: "Bearer nope" });
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: "unauthorized" });
  });
  it("right bearer -> 200 and no failure audited", async () => {
    const r = await get("/admin/devices");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([]);
    expect((await env.DB.prepare("SELECT COUNT(*) c FROM audit").first()).c).toBe(0);
  });
  it("11th attempt in an hour -> 429 even with the right token", async () => {
    for (let i = 0; i < 10; i++) expect((await get("/admin/devices", { Authorization: "Bearer bad" + i })).status).toBe(401);
    expect((await get("/admin/devices")).status).toBe(429);
  });
  it("429 is per source IP: other IP with right token still works", async () => {
    const A = { "cf-connecting-ip": "1.1.1.1" };
    const B = { "cf-connecting-ip": "2.2.2.2" };
    for (let i = 0; i < 10; i++) expect((await get("/admin/devices", { Authorization: "Bearer bad", ...A })).status).toBe(401);
    expect((await get("/admin/devices", { ...AUTH, ...A })).status).toBe(429);
    expect((await get("/admin/devices", { ...AUTH, ...B })).status).toBe(200);
  });
  it("fails closed when ADMIN_TOKEN is unset, empty or short", async () => {
    for (const secret of [undefined, "", "short-secret"]) {
      await env.DB.prepare("DELETE FROM audit").run();
      const e = { ...env, ADMIN_TOKEN: secret };
      for (const h of [{ Authorization: "Bearer undefined" }, {}, { Authorization: "Bearer " }, { Authorization: "Bearer " + (secret ?? "") }]) {
        const r = await worker.fetch(new Request("http://x/admin/devices", { headers: h }), e);
        expect(r.status).toBe(401);
      }
      expect((await env.DB.prepare("SELECT COUNT(*) c FROM audit WHERE event='admin_auth' AND ok=0").first()).c).toBe(4);
    }
  });
  it("old failures (>1h) do not count", async () => {
    for (let i = 0; i < 10; i++)
      await env.DB.prepare("INSERT INTO audit (at,event,device_id,ok,ip) VALUES (?,?,?,0,?)").bind(Date.now() - 3700_000, "admin_auth", null, await sha256hex("unknown")).run();
    expect((await get("/admin/devices")).status).toBe(200);
  });
});

describe("admin pin", () => {
  it("weak pin -> 400", async () => {
    for (const pin of ["12345", "12345a", "", 482913, null, undefined]) {
      const r = await post("/admin/pin", { pin });
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: "weak_pin" });
    }
    expect((await post("/admin/pin", null)).status).toBe(400);
  });
  it("sets hash and salt, not the pin", async () => {
    const r = await post("/admin/pin", { pin: "482913" });
    expect(r.status).toBe(200);
    const h = await env.DB.prepare("SELECT value FROM settings WHERE key='pin_hash'").first();
    const s = await env.DB.prepare("SELECT value FROM settings WHERE key='pin_salt'").first();
    expect(h.value).toBeTruthy();
    expect(h.value).not.toContain("482913");
    expect(s.value).toBeTruthy();
  });
});

describe("admin pair", () => {
  it("returns link, replaces earlier unused code", async () => {
    const a = await (await post("/admin/pair", { label: "tel" })).json();
    expect(a.link.startsWith("https://m1hu0.github.io/cv/#pair=")).toBe(true);
    expect(a.link).toBe("https://m1hu0.github.io/cv/#pair=" + a.code);
    expect(a.expiresAt).toBeGreaterThan(Date.now() + 23 * 3600_000);
    expect(a.expiresAt).toBeLessThanOrEqual(Date.now() + 24 * 3600_000);
    const rows1 = (await env.DB.prepare("SELECT * FROM pairing_codes").all()).results;
    expect(rows1.length).toBe(1);
    expect(rows1[0].code_hash).not.toBe(a.code);
    expect(rows1[0].label).toBe("tel");
    const b = await (await post("/admin/pair", { label: "alt" })).json();
    const rows2 = (await env.DB.prepare("SELECT * FROM pairing_codes").all()).results;
    expect(rows2.length).toBe(1);
    expect(b.code).not.toBe(a.code);
    expect(rows2[0].label).toBe("alt");
  });
  it("bad label -> 400", async () => {
    expect((await post("/admin/pair", { label: 5 })).status).toBe(400);
  });
});

describe("admin devices", () => {
  it("lists devices", async () => {
    await addDevice("d1", "active");
    const list = await (await get("/admin/devices")).json();
    expect(list).toEqual([{ id: "d1", label: "Ld1", status: "active", createdAt: 1000, lastSeen: 2000, lockedUntil: 0 }]);
  });
  it("approve pending -> active", async () => {
    await addDevice("d1", "pending");
    expect((await post("/admin/devices/d1/approve")).status).toBe(200);
    expect(await status("d1")).toBe("active");
  });
  it("approve unknown -> 404", async () => {
    expect((await post("/admin/devices/zz/approve")).status).toBe(404);
  });
  it("approve refused as 4th non-revoked", async () => {
    await addDevice("a", "active");
    await addDevice("b", "active");
    await addDevice("c", "locked");
    await addDevice("r", "revoked");
    await addDevice("d", "pending");
    const r = await post("/admin/devices/d/approve");
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "too_many_devices" });
    expect(await status("d")).toBe("pending");
  });
  it("approve allowed with 2 active", async () => {
    await addDevice("a", "active");
    await addDevice("b", "active");
    await addDevice("d", "pending");
    expect((await post("/admin/devices/d/approve")).status).toBe(200);
  });
  it("revoke removes sessions of that device only", async () => {
    await addDevice("d1", "active");
    await addDevice("d2", "active");
    await env.DB.prepare("INSERT INTO sessions VALUES ('h1','d1',1,1),('h2','d2',1,1)").run();
    expect((await post("/admin/devices/d1/revoke")).status).toBe(200);
    expect(await status("d1")).toBe("revoked");
    const rows = (await env.DB.prepare("SELECT device_id FROM sessions").all()).results;
    expect(rows).toEqual([{ device_id: "d2" }]);
  });
  it("unlock resets counters", async () => {
    await addDevice("d1", "locked", { fw: 5, fs: 10, ll: 3, lu: Date.now() + 99999 });
    expect((await post("/admin/devices/d1/unlock")).status).toBe(200);
    const d = await env.DB.prepare("SELECT * FROM devices WHERE id='d1'").first();
    expect(d.status).toBe("active");
    expect([d.fails_window, d.fails_since_success, d.lock_level, d.locked_until]).toEqual([0, 0, 0, 0]);
  });
  it("unlock does not resurrect revoked", async () => {
    await addDevice("d1", "revoked");
    expect((await post("/admin/devices/d1/unlock")).status).toBe(409);
    expect(await status("d1")).toBe("revoked");
  });
  it("requires auth", async () => {
    expect((await post("/admin/devices/d1/revoke", {}, {})).status).toBe(401);
  });
});

describe("admin unlock-all, audit", () => {
  it("unlock-all clears global_lock and pin_failures", async () => {
    await env.DB.prepare("INSERT INTO settings VALUES ('global_lock','1')").run();
    await env.DB.prepare("INSERT INTO pin_failures (device_id,at) VALUES ('d',1)").run();
    expect((await post("/admin/unlock-all")).status).toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) c FROM settings WHERE key='global_lock'").first()).c).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) c FROM pin_failures").first()).c).toBe(0);
  });
  it("audit newest first with limit", async () => {
    for (let i = 1; i <= 5; i++) await env.DB.prepare("INSERT INTO audit (at,event,device_id,ok) VALUES (?,?,?,1)").bind(i, "e" + i, null).run();
    const rows = await (await get("/admin/audit?limit=3")).json();
    expect(rows.map((r) => r.event)).toEqual(["e5", "e4", "e3"]);
    expect(rows[0]).toEqual({ id: expect.any(Number), at: 5, event: "e5", deviceId: null, ok: true });
    expect((await (await get("/admin/audit")).json()).length).toBe(5);
  });
});
