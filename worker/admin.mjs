#!/usr/bin/env node
// Owner CLI for the CV worker. No dependencies, Node >= 18.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(HERE);
const TOKEN_FILE = process.env.CV_ADMIN_TOKEN_FILE || path.join(os.homedir(), ".cv-admin", "token");
const URL_FILE = path.join(HERE, ".cv-api-url");

class CliError extends Error {}
const fail = (msg) => { throw new CliError(msg); };

function apiBase() {
  let u = process.env.CV_API;
  if (!u && fs.existsSync(URL_FILE)) u = fs.readFileSync(URL_FILE, "utf8");
  u = (u || "").trim().replace(/\/+$/, "");
  if (!u) fail("Lipseste adresa API: seteaza CV_API sau pune URL-ul in worker/.cv-api-url");
  return u;
}

function readToken() {
  if (!fs.existsSync(TOKEN_FILE)) fail(`Nu exista tokenul admin (${TOKEN_FILE}). Ruleaza mai intai: node admin.mjs init-token`);
  const t = fs.readFileSync(TOKEN_FILE, "utf8").trim();
  if (t.length < 32) fail("Tokenul admin din fisier este prea scurt.");
  return t;
}

async function api(method, route, body) {
  const headers = { Authorization: `Bearer ${readToken()}` };
  const init = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(apiBase() + route, init);
  } catch {
    fail("Nu m-am putut conecta la server (verifica CV_API si reteaua).");
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const code = data && typeof data.error === "string" ? data.error : "necunoscuta";
    fail(`Eroare de la server (${res.status}): ${code}`);
  }
  return data;
}

const fmt = (ms) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "-");

function table(rows, cols) {
  if (!rows.length) { console.log("(nimic)"); return; }
  const cells = rows.map((r) => cols.map(([, get]) => String(get(r))));
  const w = cols.map(([h], i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  console.log(cols.map(([h], i) => h.padEnd(w[i])).join("  "));
  for (const c of cells) console.log(c.map((x, i) => x.padEnd(w[i])).join("  "));
}

// ---- secrets piped to wrangler (never printed) ----
function putSecret(name, value, dry) {
  if (dry) {
    console.log(`would pipe ${Buffer.byteLength(value)} bytes to wrangler secret put ${name}`);
    return;
  }
  const r = spawnSync("npx", ["wrangler", "secret", "put", name], {
    cwd: HERE, input: value, shell: process.platform === "win32", stdio: ["pipe", "inherit", "inherit"],
  });
  if (r.status !== 0) fail(`wrangler secret put ${name} a esuat (esti autentificat? ruleaza: npx wrangler login)`);
}

function cmdInitToken(args) {
  const dry = args.includes("--dry-run");
  const force = args.includes("--force");
  if (fs.existsSync(TOKEN_FILE) && !force && !dry) {
    fail("Exista deja un token. Foloseste --force doar daca vrei sa-l inlocuiesti.");
  }
  const token = randomBytes(32).toString("base64url");
  // Server first: only a token the server accepted is ever written locally.
  putSecret("ADMIN_TOKEN", token, dry);
  if (!dry) {
    const dir = path.dirname(TOKEN_FILE);
    const tmp = path.join(dir, `.token.${process.pid}.tmp`);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, token + "\n", { mode: 0o600 });
      try { fs.chmodSync(tmp, 0o600); } catch { /* best effort on Windows */ }
    } catch {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      fail("Serverul are deja tokenul nou, dar nu l-am putut salva local. Ruleaza din nou: node admin.mjs init-token --force");
    }
    try {
      fs.renameSync(tmp, TOKEN_FILE);
    } catch {
      // Do NOT delete tmp: it holds the only copy of the token the server accepts.
      fail(`Serverul are deja tokenul nou, dar fisierul local NU a fost actualizat.
Tokenul nou este salvat in: ${tmp}
Redenumeste-l manual in ${TOKEN_FILE} (inchide mai intai orice program care tine fisierul deschis), apoi gata.`);
    }
  }
  console.log("done");
}

// A new DATA_KEY makes every saved version unreadable forever, so this refuses unless
// --force, and with --force also needs the server to confirm there are no versions yet
// (or the explicit --i-understand-data-loss).
async function cmdInitDataKey(args) {
  const dry = args.includes("--dry-run");
  const force = args.includes("--force");
  const acceptLoss = args.includes("--i-understand-data-loss");
  if (!force) {
    fail(`Refuz: o cheie DATA_KEY noua face ILIZIBILE toate versiunile CV-ului deja salvate.
Se ruleaza o singura data, la instalare: node admin.mjs init-data-key --force
(cu --force verific intai pe server ca nu exista nicio versiune).`);
  }
  if (!acceptLoss) {
    let list;
    try {
      list = await api("GET", "/admin/versions");
    } catch (e) {
      const why = e instanceof CliError ? e.message : "eroare necunoscuta";
      fail(`Refuz: nu pot verifica pe server daca exista versiuni salvate (${why}).
Porneste serverul / verifica CV_API si tokenul, apoi incearca din nou.
Doar daca stii sigur ca vrei sa pierzi toate versiunile: adauga --i-understand-data-loss`);
    }
    if (!Array.isArray(list)) fail("Refuz: raspuns neasteptat de la server la lista de versiuni.");
    if (list.length) {
      fail(`Refuz: pe server exista ${list.length} versiuni salvate. Cu o cheie noua NU mai pot fi citite niciodata.
Fa intai copii (node admin.mjs versions / export). Doar daca accepti pierderea: adauga --i-understand-data-loss`);
    }
  }
  putSecret("DATA_KEY", randomBytes(32).toString("base64"), dry);
  console.log("done");
}

// ---- PIN prompt ----
function readHidden(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const onData = (ch) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") {
          stdin.setRawMode(false); stdin.pause(); stdin.off("data", onData);
          process.stdout.write("\n");
          return resolve(buf);
        }
        if (c === "\u0003") { stdin.setRawMode(false); process.stdout.write("\n"); process.exit(130); }
        if (c === "\u007f" || c === "\b") buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.on("data", onData);
  });
}

async function readTwoLines() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const lines = Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
  return [lines[0] ?? "", lines[1] ?? ""];
}

async function cmdSetPin() {
  let a, b;
  if (process.stdin.isTTY) {
    a = await readHidden("PIN nou (minim 6 cifre): ");
    b = await readHidden("Repeta PIN-ul: ");
  } else {
    [a, b] = await readTwoLines();
  }
  if (a !== b) fail("PIN-urile nu se potrivesc.");
  if (!/^\d{6,}$/.test(a)) fail("PIN-ul trebuie sa aiba cel putin 6 cifre (doar cifre).");
  await api("POST", "/admin/pin", { pin: a });
  console.log("PIN setat.");
}

// ---- commands ----
async function cmdPair(args) {
  const label = args[0];
  if (!label) fail('Foloseste: pair "<eticheta>"');
  const r = await api("POST", "/admin/pair", { label });
  console.log("Link de asociere (valabil pana la " + fmt(r.expiresAt) + "):");
  console.log(r.link);
}

async function cmdDevices() {
  const rows = await api("GET", "/admin/devices");
  table(rows, [
    ["ID", (d) => d.id], ["ETICHETA", (d) => d.label], ["STARE", (d) => d.status],
    ["CREAT", (d) => fmt(d.createdAt)], ["VAZUT", (d) => fmt(d.lastSeen)],
    ["BLOCAT PANA", (d) => (d.lockedUntil > Date.now() ? fmt(d.lockedUntil) : "-")],
  ]);
}

const deviceAction = (verb, done) => async (args) => {
  const id = args[0];
  if (!id) fail(`Foloseste: ${verb} <id>`);
  await api("POST", `/admin/devices/${encodeURIComponent(id)}/${verb}`);
  console.log(done);
};

async function cmdUnlockAll() {
  await api("POST", "/admin/unlock-all");
  console.log("Blocarea globala a fost ridicata.");
}

async function cmdAudit(args) {
  const n = parseInt(args[0], 10);
  const rows = await api("GET", "/admin/audit" + (n > 0 ? `?limit=${n}` : ""));
  table(rows, [
    ["ID", (a) => a.id], ["CAND", (a) => fmt(a.at)], ["EVENIMENT", (a) => a.event],
    ["DISPOZITIV", (a) => a.deviceId ?? "-"], ["OK", (a) => (a.ok ? "da" : "nu")],
  ]);
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Returns null when `data` has the editor's shape, else a Romanian reason.
export function importProblem(data) {
  if (!isObj(data)) return "fisierul nu contine un obiect CV.";
  if (!isObj(data.personal)) return "lipseste obiectul 'personal'.";
  if (data.personal.ro !== undefined && !isObj(data.personal.ro)) return "'personal.ro' trebuie sa fie un obiect.";
  for (const list of ["work", "education"]) {
    if (!Array.isArray(data[list])) return `lipseste lista '${list}'.`;
    const i = data[list].findIndex((e) => !isObj(e) || !isObj(e.ro));
    if (i !== -1) return `intrarea ${i + 1} din '${list}' nu are obiectul 'ro'.`;
  }
  return null;
}

async function cmdImport(args) {
  const file = args[0];
  if (!file) fail("Foloseste: import <fisier.json>");
  let data;
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch { fail("Fisierul lipseste sau nu este JSON valid."); }
  const problem = importProblem(data);
  if (problem) fail("CV invalid: " + problem);
  const r = await api("POST", "/admin/import", { data });
  console.log(`Importat. Versiune: ${r.id}`);
}

async function cmdVersions() {
  const rows = await api("GET", "/admin/versions");
  table(rows, [
    ["ID", (v) => v.id], ["CREAT", (v) => fmt(v.createdAt)], ["DISPOZITIV", (v) => v.device ?? "-"],
    ["TIP", (v) => v.kind], ["MARIME", (v) => v.size], ["ULTIMA", (v) => (v.latest ? "da" : "")],
  ]);
}

function realpathLoose(p) {
  // Resolve symlinks of the nearest existing ancestor, then re-append the rest.
  let cur = path.resolve(p);
  const rest = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  return path.join(fs.realpathSync(cur), ...rest);
}

function insideRepo(out) {
  const norm = (s) => (process.platform === "win32" ? s.toLowerCase() : s);
  const rel = path.relative(norm(realpathLoose(REPO_ROOT)), norm(realpathLoose(out)));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function cmdExport(args) {
  const [id, out] = args;
  if (!id || !out) fail("Foloseste: export <id> <iesire.json>");
  if (insideRepo(out)) fail("Refuz: fisierul de iesire este in folderul proiectului (repo public). Alege un loc in afara lui.");
  const v = await api("GET", `/admin/versions/${encodeURIComponent(id)}`);
  fs.writeFileSync(out, JSON.stringify(v.data, null, 2), { mode: 0o600 });
  console.log(`Exportat in ${path.resolve(out)}`);
}

const COMMANDS = {
  "init-token": cmdInitToken,
  "init-data-key": cmdInitDataKey,
  "set-pin": cmdSetPin,
  pair: cmdPair,
  devices: cmdDevices,
  approve: deviceAction("approve", "Dispozitiv aprobat."),
  revoke: deviceAction("revoke", "Dispozitiv revocat."),
  unlock: deviceAction("unlock", "Dispozitiv deblocat."),
  "unlock-all": cmdUnlockAll,
  audit: cmdAudit,
  import: cmdImport,
  versions: cmdVersions,
  export: cmdExport,
};

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const fn = COMMANDS[cmd];
  if (!fn) {
    console.error("Comenzi: " + Object.keys(COMMANDS).join(", "));
    process.exit(cmd ? 2 : 0);
  }
  await fn(args);
}

// Run only as a script (tests import importProblem without running a command).
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e instanceof CliError ? e.message : "Eroare neasteptata.");
    process.exit(1);
  });
}
