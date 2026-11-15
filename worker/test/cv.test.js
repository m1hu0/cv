import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { call, makeSession, resetDb, ADMIN } from "./helpers.js";

const cv = (name, extra = {}) => ({ personal: { name }, work: [], ...extra });
const rows = async () => (await env.DB.prepare("SELECT * FROM versions ORDER BY id").all()).results;
const base = (r) => ({ id: r.id, rev: r.rev });
const latestId = async () => (await env.DB.prepare("SELECT value FROM settings WHERE key='latest_version_id'").first())?.value ?? null;

let s;
beforeEach(async () => {
  await resetDb();
  s = await makeSession("d1", "Telefon");
});

describe("auth", () => {
  it("no session -> 401 on every route", async () => {
    for (const [m, p] of [["GET", "/cv"], ["POST", "/cv"], ["GET", "/versions"], ["GET", "/versions/1"], ["POST", "/versions/1/restore"]]) {
      const r = await call(p, { method: m, headers: m === "POST" ? { "content-type": "application/json" } : {}, body: m === "POST" ? "{}" : undefined });
      expect(r.status).toBe(401);
    }
  });
});

describe("POST /cv and GET /cv", () => {
  it("empty -> {id:null,data:null}", async () => {
    expect(await (await s.get("/cv")).json()).toEqual({ id: null, data: null });
  });
  it("first save becomes latest; GET /cv returns it; ciphertext hides plaintext", async () => {
    const r = await s.post("/cv", { data: cv("Ion Exemplu Popescu"), basedOn: null, kind: "manual" });
    expect(r.status).toBe(200);
    const { id, latest } = await r.json();
    expect(latest).toBe(true);
    const got = await (await s.get("/cv")).json();
    expect(got.id).toBe(id);
    expect(got.data).toEqual(cv("Ion Exemplu Popescu"));
    expect(typeof got.createdAt).toBe("number");
    const [row] = await rows();
    expect(row.blob).not.toContain("Exemplu");
    expect(row.device_label).toBe("Telefon");
    expect(row.size).toBe(JSON.stringify(cv("Ion Exemplu Popescu")).length);
  });
  it("auto twice within 10 min overwrites in place", async () => {
    const a = await (await s.post("/cv", { data: cv("A"), basedOn: null, kind: "auto" })).json();
    const b = await (await s.post("/cv", { data: cv("B"), basedOn: base(a), kind: "auto" })).json();
    expect(b).toEqual({ id: a.id, rev: a.rev + 1, latest: true });
    expect((await rows()).length).toBe(1);
    expect((await (await s.get("/cv")).json()).data.personal.name).toBe("B");
  });
  it("responses carry rev: POST, GET /cv, stale current", async () => {
    const a = await (await s.post("/cv", { data: cv("A"), basedOn: null, kind: "manual" })).json();
    expect(a.rev).toBe(1);
    const got = await (await s.get("/cv")).json();
    expect([got.id, got.rev]).toEqual([a.id, 1]);
    const st = await (await s.post("/cv", { data: cv("B"), basedOn: null, kind: "manual" })).json();
    expect(st.latest).toBe(false);
    expect([st.current.id, st.current.rev]).toEqual([a.id, 1]);
    expect(st.rev).toBe(1);
  });
  it("in-place auto saves bump rev; a save based on an older rev of the same id is stale", async () => {
    // device A: two auto-saves collapsed into one row
    const a1 = await (await s.post("/cv", { data: cv("A1"), basedOn: null, kind: "auto" })).json();
    const a2 = await (await s.post("/cv", { data: cv("A2"), basedOn: base(a1), kind: "auto" })).json();
    expect(a2.id).toBe(a1.id);
    expect(a2.rev).toBe(a1.rev + 1);
    // device B loaded A1 (same id, older rev) and saves
    const sB = await makeSession("d2", "Tableta");
    const b = await (await sB.post("/cv", { data: cv("B"), basedOn: base(a1), kind: "manual" })).json();
    expect(b.latest).toBe(false);
    expect(b.current.id).toBe(a1.id);
    expect(b.current.rev).toBe(a2.rev);
    expect(b.current.data.personal.name).toBe("A2");
    const got = await (await s.get("/cv")).json();
    expect(got.data.personal.name).toBe("A2");
    expect(await latestId()).toBe(String(a1.id));
  });
  it("same label with an older rev cannot overwrite the auto row in place", async () => {
    const a1 = await (await s.post("/cv", { data: cv("A1"), basedOn: null, kind: "auto" })).json();
    await s.post("/cv", { data: cv("A2"), basedOn: base(a1), kind: "auto" });
    const s2 = await makeSession("d3", "Telefon"); // second context, same label
    const r = await (await s2.post("/cv", { data: cv("X"), basedOn: base(a1), kind: "auto" })).json();
    expect(r.latest).toBe(false);
    expect(r.id).not.toBe(a1.id);
    expect((await (await s.get("/cv")).json()).data.personal.name).toBe("A2");
  });
  it("restore returns rev; restore with an older rev is stale", async () => {
    const a1 = await (await s.post("/cv", { data: cv("A1"), basedOn: null, kind: "auto" })).json();
    const a2 = await (await s.post("/cv", { data: cv("A2"), basedOn: base(a1), kind: "auto" })).json();
    const st = await (await s.post(`/versions/${a1.id}/restore`, { basedOn: base(a1) })).json();
    expect(st.latest).toBe(false);
    expect(st.current.rev).toBe(a2.rev);
    const ok = await (await s.post(`/versions/${a1.id}/restore`, { basedOn: base(st.current) })).json();
    expect(ok.latest).toBe(true);
    expect(ok.rev).toBe(1);
    expect((await (await s.get("/cv")).json()).rev).toBe(1);
  });
  it("auto after 10 min inserts new row", async () => {
    const a = await (await s.post("/cv", { data: cv("A"), basedOn: null, kind: "auto" })).json();
    await env.DB.prepare("UPDATE versions SET updated_at = updated_at - 11*60*1000").run();
    const b = await (await s.post("/cv", { data: cv("B"), basedOn: base(a), kind: "auto" })).json();
    expect(b.id).not.toBe(a.id);
    expect((await rows()).length).toBe(2);
  });
  it("auto from another device does not overwrite", async () => {
    const a = await (await s.post("/cv", { data: cv("A"), basedOn: null, kind: "auto" })).json();
    const s2 = await makeSession("d2", "Laptop");
    const b = await (await s2.post("/cv", { data: cv("B"), basedOn: base(a), kind: "auto" })).json();
    expect(b.id).not.toBe(a.id);
  });
  it("auto after manual inserts; manual twice gives two rows", async () => {
    const a = await (await s.post("/cv", { data: cv("A"), basedOn: null, kind: "manual" })).json();
    const b = await (await s.post("/cv", { data: cv("B"), basedOn: base(a), kind: "auto" })).json();
    expect(b.id).not.toBe(a.id);
    const c = await (await s.post("/cv", { data: cv("C"), basedOn: base(b), kind: "manual" })).json();
    const d = await (await s.post("/cv", { data: cv("D"), basedOn: base(c), kind: "manual" })).json();
    expect(d.id).not.toBe(c.id);
    expect((await rows()).length).toBe(4);
  });
  it("stale save (auto too) is stored but not latest, returns current", async () => {
    const v1 = await (await s.post("/cv", { data: cv("one"), basedOn: null, kind: "manual" })).json();
    const a = await (await s.post("/cv", { data: cv("A"), basedOn: base(v1), kind: "manual" })).json();
    const r = await (await s.post("/cv", { data: cv("B"), basedOn: base(v1), kind: "auto" })).json();
    expect(r.latest).toBe(false);
    expect(r.current.id).toBe(a.id);
    expect(r.current.data.personal.name).toBe("A");
    expect(await latestId()).toBe(String(a.id));
    expect((await rows()).length).toBe(3);
  });
  it("concurrent saves with same basedOn: exactly one latest", async () => {
    const v1 = await (await s.post("/cv", { data: cv("one"), basedOn: null, kind: "manual" })).json();
    const rs = await Promise.all([1, 2, 3, 4].map((i) => s.post("/cv", { data: cv("c" + i), basedOn: base(v1), kind: "manual" }).then((r) => r.json())));
    expect(rs.filter((r) => r.latest).length).toBe(1);
    const winner = rs.find((r) => r.latest);
    expect(await latestId()).toBe(String(winner.id));
    for (const l of rs.filter((r) => !r.latest)) expect(l.current.id).toBe(winner.id);
  });
  it("concurrent first saves (null base): exactly one latest", async () => {
    const rs = await Promise.all([1, 2, 3].map((i) => s.post("/cv", { data: cv("c" + i), basedOn: null, kind: "manual" }).then((r) => r.json())));
    expect(rs.filter((r) => r.latest).length).toBe(1);
  });
  it("null base when a latest exists is stale", async () => {
    const a = await (await s.post("/cv", { data: cv("A"), basedOn: null, kind: "manual" })).json();
    const r = await (await s.post("/cv", { data: cv("B"), basedOn: null, kind: "manual" })).json();
    expect(r.latest).toBe(false);
    expect(r.current.id).toBe(a.id);
  });
  it("validation -> 400 bad_cv", async () => {
    const bad = [
      { data: {}, basedOn: null, kind: "manual" },
      { data: { personal: {}, work: {} }, basedOn: null, kind: "manual" },
      { data: { personal: [], work: [] }, basedOn: null, kind: "manual" },
      { data: { personal: null, work: [] }, basedOn: null, kind: "manual" },
      { data: [], basedOn: null, kind: "manual" },
      { data: "x", basedOn: null, kind: "manual" },
      { basedOn: null, kind: "manual" },
      { data: cv("A"), basedOn: null, kind: "restore" },
      { data: cv("A"), basedOn: null, kind: "bogus" },
      { data: cv("A"), basedOn: "1", kind: "manual" },
      { data: cv("A"), basedOn: 1.5, kind: "manual" },
      { data: cv("A"), basedOn: 1, kind: "manual" },
      { data: cv("A"), basedOn: { id: 1 }, kind: "manual" },
      { data: cv("A"), basedOn: { id: 1, rev: 0 }, kind: "manual" },
      { data: cv("A"), basedOn: { id: "1", rev: 1 }, kind: "manual" },
      { data: cv("A"), basedOn: { id: 1, rev: 1.5 }, kind: "manual" },
      { data: cv("A"), basedOn: [1, 1], kind: "manual" },
      { data: cv("A"), kind: "manual" },
      null, [], "x", 5,
    ];
    for (const b of bad) {
      const r = await s.post("/cv", b);
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: "bad_cv" });
    }
    expect((await rows()).length).toBe(0);
  });
  it("audits save", async () => {
    await s.post("/cv", { data: cv("A"), basedOn: null, kind: "manual" });
    const a = await env.DB.prepare("SELECT * FROM audit WHERE event='save'").first();
    expect([a.device_id, a.ok]).toEqual(["d1", 1]);
  });
  it("wrong DATA_KEY on read -> 500 server, no ciphertext", async () => {
    await s.post("/cv", { data: cv("A"), basedOn: null, kind: "manual" });
    const [row] = await rows();
    const good = env.DATA_KEY;
    env.DATA_KEY = "ZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmY=";
    try {
      const r = await s.get("/cv");
      expect(r.status).toBe(500);
      const t = await r.text();
      expect(t).toBe('{"error":"server"}');
      expect(t).not.toContain(row.blob);
    } finally {
      env.DATA_KEY = good;
    }
  });
});

describe("internal errors", () => {
  it("allowed-origin request that fails internally -> 500 server with CORS headers", async () => {
    await s.post("/cv", { data: cv("A"), basedOn: null, kind: "manual" });
    const good = env.DATA_KEY;
    env.DATA_KEY = "ZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmY=";
    try {
      const r = await call("/cv", { headers: { Authorization: "Bearer " + s.token, Origin: "http://localhost:8000" } });
      expect(r.status).toBe(500);
      expect(await r.json()).toEqual({ error: "server" });
      expect(r.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:8000");
      expect(r.headers.get("Cache-Control")).toBe("no-store");
    } finally {
      env.DATA_KEY = good;
    }
  });
});

describe("versions", () => {
  it("lists newest first with latest flag, no ciphertext", async () => {
    const a = await (await s.post("/cv", { data: cv("A"), basedOn: null, kind: "manual" })).json();
    const b = await (await s.post("/cv", { data: cv("B"), basedOn: base(a), kind: "manual" })).json();
    const list = await (await s.get("/versions")).json();
    expect(list.map((v) => v.id)).toEqual([b.id, a.id]);
    expect(list.map((v) => v.latest)).toEqual([true, false]);
    expect(Object.keys(list[0]).sort()).toEqual(["createdAt", "device", "id", "kind", "latest", "size", "updatedAt"]);
    expect(list[0].device).toBe("Telefon");
  });
  it("GET /versions/:id; unknown or non-numeric -> 404", async () => {
    const a = await (await s.post("/cv", { data: cv("A"), basedOn: null, kind: "manual" })).json();
    const got = await (await s.get("/versions/" + a.id)).json();
    expect(got.id).toBe(a.id);
    expect(got.data).toEqual(cv("A"));
    for (const p of ["/versions/999", "/versions/abc", "/versions/1.5", "/versions/-1"]) {
      const r = await s.get(p);
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: "not_found" });
    }
  });
  it("restore creates a new latest with the old data", async () => {
    const a = await (await s.post("/cv", { data: cv("one"), basedOn: null, kind: "manual" })).json();
    const b = await (await s.post("/cv", { data: cv("two"), basedOn: base(a), kind: "manual" })).json();
    const r = await (await s.post(`/versions/${a.id}/restore`, { basedOn: base(b) })).json();
    expect(r.latest).toBe(true);
    expect(r.id).not.toBe(a.id);
    const got = await (await s.get("/cv")).json();
    expect(got.id).toBe(r.id);
    expect(got.data).toEqual(cv("one"));
    expect((await env.DB.prepare("SELECT kind FROM versions WHERE id=?").bind(r.id).first()).kind).toBe("restore");
    expect((await env.DB.prepare("SELECT * FROM audit WHERE event='restore'").first()).ok).toBe(1);
  });
  it("restore stale base -> latest:false", async () => {
    const a = await (await s.post("/cv", { data: cv("one"), basedOn: null, kind: "manual" })).json();
    const b = await (await s.post("/cv", { data: cv("two"), basedOn: base(a), kind: "manual" })).json();
    const r = await (await s.post(`/versions/${a.id}/restore`, { basedOn: base(a) })).json();
    expect(r.latest).toBe(false);
    expect(r.current.id).toBe(b.id);
  });
  it("restore unknown id -> 404; bad basedOn -> 400", async () => {
    expect((await s.post("/versions/999/restore", { basedOn: null })).status).toBe(404);
    expect((await s.post("/versions/abc/restore", { basedOn: null })).status).toBe(404);
    const a = await (await s.post("/cv", { data: cv("one"), basedOn: null, kind: "manual" })).json();
    expect((await s.post(`/versions/${a.id}/restore`, { basedOn: "x" })).status).toBe(400);
  });
});

describe("admin", () => {
  const apost = (p, body, h = ADMIN) => call(p, { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify(body) });
  it("import becomes latest regardless of base, label admin", async () => {
    await s.post("/cv", { data: cv("A"), basedOn: null, kind: "manual" });
    const r = await apost("/admin/import", { data: cv("imported") });
    expect(r.status).toBe(200);
    const { id } = await r.json();
    expect(await latestId()).toBe(String(id));
    const row = await env.DB.prepare("SELECT kind, device_label FROM versions WHERE id=?").bind(id).first();
    expect(row).toEqual({ kind: "import", device_label: "admin" });
    expect((await (await s.get("/cv")).json()).data.personal.name).toBe("imported");
    expect((await env.DB.prepare("SELECT * FROM audit WHERE event='import'").first()).ok).toBe(1);
  });
  it("import validates and requires admin", async () => {
    expect((await apost("/admin/import", { data: {} })).status).toBe(400);
    expect((await apost("/admin/import", { data: cv("x") }, {})).status).toBe(401);
  });
  it("admin versions list and get", async () => {
    const { id } = await (await apost("/admin/import", { data: cv("imp") })).json();
    const list = await (await call("/admin/versions", { headers: ADMIN })).json();
    expect(list[0].id).toBe(id);
    expect(list[0].latest).toBe(true);
    const got = await (await call("/admin/versions/" + id, { headers: ADMIN })).json();
    expect(got.data).toEqual(cv("imp"));
    expect((await call("/admin/versions/999", { headers: ADMIN })).status).toBe(404);
    expect((await call("/admin/versions", {})).status).toBe(401);
  });
});
