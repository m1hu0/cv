import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "worker", "admin.mjs");
const { importProblem } = await import("../worker/admin.mjs");

let dir, tokenFile, server, port, versions;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cv-admin-test-"));
  tokenFile = path.join(dir, "token");
  fs.writeFileSync(tokenFile, "throwaway-test-token-0123456789abcdef0123\n");
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/admin/versions") return res.end(JSON.stringify(versions));
    res.statusCode = 404;
    res.end('{"error":"not_found"}');
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});
after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// Never runs wrangler: every call that could reach putSecret passes --dry-run.
function run(args, api = `http://127.0.0.1:${port}`) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, CV_API: api, CV_ADMIN_TOKEN_FILE: tokenFile },
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });
}

test("init-data-key without --force refuses", async () => {
  const r = await run(["init-data-key", "--dry-run"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /Refuz/);
  assert.doesNotMatch(r.out, /would pipe/);
});

test("init-data-key --force refuses when versions exist", async () => {
  versions = [{ id: 1 }, { id: 2 }];
  const r = await run(["init-data-key", "--force", "--dry-run"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /2 versiuni/);
  assert.doesNotMatch(r.out, /would pipe/);
});

test("init-data-key --force refuses when the server cannot be reached", async () => {
  const r = await run(["init-data-key", "--force", "--dry-run"], "http://127.0.0.1:1");
  assert.equal(r.code, 1);
  assert.match(r.out, /nu pot verifica/);
  assert.doesNotMatch(r.out, /would pipe/);
});

test("init-data-key --force proceeds when the server has no versions", async () => {
  versions = [];
  const r = await run(["init-data-key", "--force", "--dry-run"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /would pipe 44 bytes to wrangler secret put DATA_KEY/);
});

test("init-data-key --force --i-understand-data-loss skips the check", async () => {
  const r = await run(["init-data-key", "--force", "--i-understand-data-loss", "--dry-run"], "http://127.0.0.1:1");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /would pipe/);
});

test("importProblem accepts the editor shape and rejects broken entries", () => {
  const ok = { personal: { ro: { name: "" } }, work: [{ ro: { role: "x" } }], education: [] };
  assert.equal(importProblem(ok), null);
  assert.equal(importProblem({ personal: {}, work: [], education: [] }), null);
  const bad = [
    null, [], "x",
    { work: [], education: [] },
    { personal: [], work: [], education: [] },
    { personal: { ro: "x" }, work: [], education: [] },
    { personal: {}, work: {}, education: [] },
    { personal: {}, work: [] },
    { personal: {}, work: [], education: {} },
    { personal: {}, work: [{}], education: [] },
    { personal: {}, work: [{ ro: [] }], education: [] },
    { personal: {}, work: [], education: [null] },
    { personal: {}, work: [], education: [{ ro: "x" }] },
  ];
  for (const b of bad) assert.equal(typeof importProblem(b), "string", JSON.stringify(b));
});

test("import refuses a broken file before contacting the server", async () => {
  const f = path.join(dir, "bad.json");
  fs.writeFileSync(f, JSON.stringify({ personal: {}, work: [{ role: "x" }], education: [] }));
  const r = await run(["import", f], "http://127.0.0.1:1");
  assert.equal(r.code, 1);
  assert.match(r.out, /CV invalid: intrarea 1 din 'work'/);
});
