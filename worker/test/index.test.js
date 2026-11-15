import { describe, it, expect } from "vitest";
import { env, exports } from "cloudflare:workers";
import { getSetting, setSetting, audit, now } from "../src/db.js";
import { compile, matchRoute } from "../src/index.js";

const call = (path, init) => exports.default.fetch(new Request("http://x" + path, init));

describe("router", () => {
  it("OPTIONS preflight allowed origin", async () => {
    const r = await call("/cv", { method: "OPTIONS", headers: { Origin: "http://localhost:8000" } });
    expect(r.status).toBe(204);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:8000");
    expect(r.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
    expect(r.headers.get("Access-Control-Allow-Headers")).toContain("Content-Type");
  });
  it("rejects foreign origin", async () => {
    const r = await call("/cv", { headers: { Origin: "https://evil.example" } });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "origin" });
    expect(r.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
  it("404 json no-store", async () => {
    const r = await call("/nope");
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "not_found" });
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    expect(r.headers.get("Content-Type")).toContain("application/json");
  });
  it("413 on big body", async () => {
    const r = await call("/x", { method: "POST", body: "a".repeat(1.5 * 1024 * 1024 + 1) });
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ error: "too_big" });
  });
  it("400 on bad json", async () => {
    const r = await call("/x", { method: "POST", body: "{nope", headers: { "content-type": "application/json" } });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "bad_json" });
  });
  it("CORS headers on normal responses for allowed origin", async () => {
    const r = await call("/nope", { headers: { Origin: "http://localhost:8000" } });
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:8000");
  });
});

describe("db helpers", () => {
  it("settings roundtrip and delete", async () => {
    expect(await getSetting(env, "k")).toBeNull();
    await setSetting(env, "k", "v");
    expect(await getSetting(env, "k")).toBe("v");
    await setSetting(env, "k", "w");
    expect(await getSetting(env, "k")).toBe("w");
    await setSetting(env, "k", null);
    expect(await getSetting(env, "k")).toBeNull();
  });
  it("audit writes a row", async () => {
    await audit(env, "login", "dev1", true);
    const row = await env.DB.prepare("SELECT * FROM audit WHERE device_id='dev1'").first();
    expect(row.event).toBe("login");
    expect(row.ok).toBe(1);
    expect(Math.abs(row.at - now())).toBeLessThan(10000);
  });
});

describe("matcher", () => {
  const table = compile({ "GET /versions/:id": () => null });
  it("extracts params", () => {
    expect(matchRoute(table, "GET", "/versions/12").params).toEqual({ id: "12" });
  });
  it("malformed percent-encoding is no match, not a throw", () => {
    expect(matchRoute(table, "GET", "/versions/%E0%A4%A")).toBeNull();
  });
});
