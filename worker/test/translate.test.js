import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:workers";
import { call, makeSession, resetDb } from "./helpers.js";

// pool-workers 0.23 has no fetchMock: stub globalThis.fetch (no network in tests).
const realFetch = globalThis.fetch;
let calls;
let responder;
const gem = (obj) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: typeof obj === "string" ? obj : JSON.stringify(obj) }] } }] }), { status: 200 });
const status = (n, body = {}) => new Response(JSON.stringify(body), { status: n });

const entry = (over = {}) => ({
  kind: "entry", section: "work", current: false,
  input: { role: "Tehnician", employer: "SC Exemplu SRL", place: "Brașov, România", subtitle: "", lines: ["Montaj tablouri", "Punere în funcțiune"] },
  ...over,
});
const okEntry = { role: "Technician", employer: "SC Exemplu SRL", place: "Brasov, Romania", subtitle: "", lines: ["Installed panels.", "Commissioned systems."] };
const personalIn = { name: "A B", birth: "01.01.1990", nationality: "Română", phone: "0700", email: "a@b.ro", address: "Strada Florilor 10" };
const outText = (i) => JSON.parse(calls[i].init.body).contents[0].parts[0].text;

let s;
beforeEach(async () => {
  await resetDb();
  await env.DB.prepare("DELETE FROM translate_usage").run();
  s = await makeSession();
  calls = [];
  responder = () => gem(okEntry);
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return responder(calls.length - 1, String(url)); };
});
afterEach(() => { globalThis.fetch = realFetch; });

describe("POST /translate", () => {
  it("no session -> 401, no outbound call", async () => {
    const r = await call("/translate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(entry()) });
    expect(r.status).toBe(401);
    expect(calls.length).toBe(0);
  });

  it("entry happy path; key in header, not URL", async () => {
    const r = await s.post("/translate", entry());
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(okEntry);
    expect(calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent");
    expect(calls[0].url).not.toContain("key=");
    expect(new Headers(calls[0].init.headers).get("x-goog-api-key")).toBe("test-gemini-key");
    const row = await env.DB.prepare("SELECT * FROM audit WHERE event='translate'").first();
    expect(row.ok).toBe(1);
  });

  it("prompt reflects current/past/education", async () => {
    await s.post("/translate", entry({ current: false }));
    expect(outText(0)).toContain("PAST job");
    await s.post("/translate", entry({ current: true }));
    expect(outText(1)).toContain("CURRENT job");
    await s.post("/translate", entry({ section: "education" }));
    expect(outText(2)).toContain("EDUCATION");
  });

  it("personal happy path", async () => {
    responder = () => gem({ ...personalIn, nationality: "Romanian" });
    const r = await s.post("/translate", { kind: "personal", input: personalIn });
    expect(r.status).toBe(200);
    expect((await r.json()).nationality).toBe("Romanian");
    expect(outText(0)).toContain("personal-details");
  });

  it("bad input -> 400 bad_input, no outbound call, no count", async () => {
    const e = entry();
    const bad = [
      { ...e, extra: 1 },
      { ...e, input: { ...e.input, extra: "x" } },
      { ...e, input: { ...e.input, role: 5 } },
      { ...e, input: { ...e.input, lines: "x" } },
      { ...e, input: { ...e.input, lines: [1] } },
      { ...e, input: { ...e.input, lines: Array(51).fill("a") } },
      { ...e, input: { ...e.input, lines: ["a".repeat(9000)] } },
      { ...e, section: "other" },
      { ...e, current: "no" },
      { kind: "personal", input: { ...personalIn, extra: "x" } },
      { kind: "personal", input: { name: "x" } },
      { kind: "nope", input: {} },
      [], null, "str",
    ];
    for (const b of bad) {
      const r = await s.post("/translate", b);
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: "bad_input" });
    }
    expect(calls.length).toBe(0);
    expect(await env.DB.prepare("SELECT * FROM translate_usage").first()).toBeNull();
  });

  it("first model 429 then second ok", async () => {
    responder = (i) => (i === 0 ? status(429) : gem(okEntry));
    const r = await s.post("/translate", entry());
    expect(r.status).toBe(200);
    expect(calls.length).toBe(2);
    expect(calls[1].url).toContain("gemini-2.5-flash:");
  });

  it("404 falls through too; all failing -> 503", async () => {
    responder = (i) => (i === 0 ? status(404) : status(429));
    const r = await s.post("/translate", entry());
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "unavailable" });
    expect(calls.length).toBe(3);
  });

  it("403 or 400 api key -> 500 server, no leak", async () => {
    responder = () => status(403, { error: { message: "secret-detail test-gemini-key" } });
    let r = await s.post("/translate", entry());
    expect(r.status).toBe(500);
    expect(await r.text()).toBe(JSON.stringify({ error: "server" }));
    responder = () => status(400, { error: { message: "API key not valid" } });
    r = await s.post("/translate", entry());
    expect(r.status).toBe(500);
    expect(calls.length).toBe(2);
  });

  it("network failure on every model -> 503", async () => {
    responder = () => { throw new TypeError("boom"); };
    const r = await s.post("/translate", entry());
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "unavailable" });
    expect(calls.length).toBe(3);
  });

  it("every model call has a 20 s timeout signal", async () => {
    const orig = AbortSignal.timeout;
    const seen = [];
    AbortSignal.timeout = (ms) => { seen.push(ms); return orig.call(AbortSignal, ms); };
    try {
      responder = (i) => (i === 0 ? status(429) : gem(okEntry));
      expect((await s.post("/translate", entry())).status).toBe(200);
    } finally { AbortSignal.timeout = orig; }
    expect(seen).toEqual([20000, 20000]);
    for (const c of calls) expect(c.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("timeout on a model counts like a network error: next model is tried", async () => {
    responder = (i) => {
      if (i === 0) throw new DOMException("The operation timed out.", "TimeoutError");
      return gem(okEntry);
    };
    const r = await s.post("/translate", entry());
    expect(r.status).toBe(200);
    expect(calls.length).toBe(2);
  });

  it("null JSON bodies never 500", async () => {
    responder = () => new Response("null", { status: 200 });
    let r = await s.post("/translate", entry());
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: "bad_output" });
    calls = [];
    responder = (i) => (i === 0 ? new Response("null", { status: 400 }) : gem(okEntry));
    r = await s.post("/translate", entry());
    expect(r.status).toBe(200);
    expect(calls.length).toBe(2);
  });

  it("fewer lines -> 502 bad_output immediately", async () => {
    responder = () => gem({ ...okEntry, lines: ["only one"] });
    const r = await s.post("/translate", entry());
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: "bad_output" });
    expect(calls.length).toBe(1);
  });

  it("unparseable output -> 502; fenced JSON accepted; missing keys -> empty strings", async () => {
    responder = () => gem("not json");
    expect((await s.post("/translate", entry())).status).toBe(502);
    responder = () => gem("```json\n" + JSON.stringify({ lines: ["a", "b"], role: "R" }) + "\n```");
    const r = await s.post("/translate", entry());
    expect(await r.json()).toEqual({ role: "R", employer: "", place: "", subtitle: "", lines: ["a", "b"] });
  });

  it("missing GEMINI_KEY -> 500 without calling out", async () => {
    const saved = env.GEMINI_KEY;
    env.GEMINI_KEY = "";
    try {
      const r = await s.post("/translate", entry());
      expect(r.status).toBe(500);
      expect(calls.length).toBe(0);
    } finally { env.GEMINI_KEY = saved; }
  });

  it("301st call of the day -> 429 limit", async () => {
    const day = new Date().toISOString().slice(0, 10);
    await env.DB.prepare("INSERT INTO translate_usage (day,count) VALUES (?,?)").bind(day, 299).run();
    expect((await s.post("/translate", entry())).status).toBe(200);
    const r = await s.post("/translate", entry());
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({ error: "limit" });
    expect(calls.length).toBe(1);
    expect((await env.DB.prepare("SELECT count FROM translate_usage WHERE day=?").bind(day).first()).count).toBe(300);
  });

  it("failed Gemini call still counts", async () => {
    responder = () => status(429);
    await s.post("/translate", entry());
    const day = new Date().toISOString().slice(0, 10);
    expect((await env.DB.prepare("SELECT count FROM translate_usage WHERE day=?").bind(day).first()).count).toBe(1);
  });
});
