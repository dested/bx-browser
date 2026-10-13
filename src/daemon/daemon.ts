// bx daemon: one process per profile, holds the browser, speaks localhost HTTP.
// Started detached by the CLI; stdout is redirected to ~/.bx/logs/<profile>.log.
//
//   node src/daemon/daemon.ts --profile <name> [--headless]
//
// Runtime-neutral on purpose (node:http, node:fs — no Bun.* APIs): Playwright
// cannot drive Chrome from Bun, so the daemon must be able to run under Node.
// See the launch notes in session.ts.

// Must stay first: patches child_process before Playwright spawns anything.
import "./hideWindows.ts";
import * as nodeModule from "node:module";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BX_DIR_NAME,
  CLIENT_HEADER,
  CmdSchema,
  DEADLINE_HEADER,
  DEFAULT_DEADLINE_MS,
  LOGS_DIR,
  PROFILES_DIR,
  RUN_DIR,
  SNAPS_DIR,
  type BxError,
  type Cmd,
  type CmdResult,
  type HealthResult,
  type RunFile,
} from "../protocol.ts";
import { Session, steps } from "./session.ts";
import {
  harnessRoutes,
  recordBusy,
  recordDistill,
  recordMark,
  recordSave,
  recordStart,
  recordStatus,
  recordStop,
  recordingSlug,
} from "./record.ts";
import { collectDebug, heapSnapshot, Journal, parseClientTag, runGc } from "./debug.ts";
import { pruneSnaps, snapDays } from "./orphans.ts";
import { serveArgv } from "../argv/serve.ts";

// K2: cache V8 bytecode for modules loaded from here on (chiefly the lazy
// playwright-core import, ~45 ms saved per cold start). Node 22.1+ only.
if (typeof nodeModule.enableCompileCache === "function") nodeModule.enableCompileCache();

const ERROR_CODES: readonly string[] = [
  "target_not_found",
  "stale_ref",
  "timeout",
  "no_page",
  "not_recording",
  "already_recording",
  "browser_launch_failed",
  "browser_dead",
  "deadline",
  "ambiguous",
  "bad_request",
  "internal",
];

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

function parseArgs(argv: string[]): { profile: string; headless: boolean } {
  let profile = "default";
  let headless = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--profile") {
      const next = argv[i + 1];
      if (next !== undefined) {
        profile = next;
        i++;
      }
    } else if (arg === "--headless") {
      headless = true;
    }
  }
  return { profile, headless };
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function send(res: ServerResponse, status: number, type: string, body: Buffer | string): void {
  const buf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  res.writeHead(status, { "content-type": type, "content-length": buf.length });
  res.end(buf);
}

function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function isBxError(err: unknown): err is BxError {
  if (typeof err !== "object" || err === null) return false;
  if (!("code" in err) || !("message" in err)) return false;
  return (
    typeof err.code === "string" && typeof err.message === "string" && ERROR_CODES.includes(err.code)
  );
}

function toBxError(err: unknown): BxError {
  if (isBxError(err)) return err;
  if (err instanceof Error && err.name === "TimeoutError") {
    return { code: "timeout", message: err.message };
  }
  return { code: "internal", message: String(err) };
}

function fail(error: BxError): CmdResult<never> {
  return { ok: false, error };
}

/** The tab a result describes (ActionResult, OpenResult, DriveResult), for the log. */
function resultTab(data: unknown): number | undefined {
  if (typeof data !== "object" || data === null || !("page" in data)) return undefined;
  const page = data.page;
  if (typeof page !== "object" || page === null || !("id" in page)) return undefined;
  return typeof page.id === "number" ? page.id : undefined;
}

function resultSettle(data: unknown): number | undefined {
  if (typeof data !== "object" || data === null || !("settledMs" in data)) return undefined;
  return typeof data.settledMs === "number" ? data.settledMs : undefined;
}

const DEADLINE_MIN_MS = 1000;
const DEADLINE_MAX_MS = 600_000;
const RECORD_START_DEADLINE_MS = 60_000;

/** The client's deadline header (default 10 s), clamped. */
function deadlineFromHeader(header: string | string[] | undefined): number {
  const raw = Number(Array.isArray(header) ? header[0] : header);
  const asked = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DEADLINE_MS;
  return Math.min(DEADLINE_MAX_MS, Math.max(DEADLINE_MIN_MS, asked));
}

/**
 * How long a command may run (R3), or null for none. The header (default 10 s,
 * clamped) is raised to cover a command's own timeout so an explicit
 * `--timeout 20000` wait isn't cut off at 10 s; drive gets its own budget and
 * the recording commands that encode are exempt: stop (a ring encodes its
 * frames there, --mp4 transcodes), save and distill can take minutes. Start
 * gets at least 60 s: a machine's first one installs Playwright's ffmpeg. Mark
 * and status keep the default.
 */
function deadlineFor(cmd: Cmd, header: string | string[] | undefined): number | null {
  if (cmd.cmd === "recordStop" || cmd.cmd === "recordSave" || cmd.cmd === "recordDistill") return null;
  if (cmd.cmd === "drive") return (cmd.timeoutMs ?? 15000) + 5000;
  if (cmd.cmd === "recordStart") return Math.max(RECORD_START_DEADLINE_MS, deadlineFromHeader(header));
  let ms = deadlineFromHeader(header);
  if ("timeoutMs" in cmd && cmd.timeoutMs !== undefined) ms = Math.max(ms, cmd.timeoutMs + 5000);
  if (cmd.cmd === "wait" && cmd.ms !== undefined) ms = Math.max(ms, Math.min(cmd.ms, 30000) + 5000);
  return Math.min(DEADLINE_MAX_MS, ms);
}

/**
 * Answers `deadline` when `work` outruns `ms`. The work itself is abandoned,
 * not cancelled: Playwright has no way to interrupt a hung evaluate, so its
 * eventual result (or error) is discarded.
 */
function withDeadline<T>(work: Promise<T>, ms: number, tracker: { label: string }): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject({ code: "deadline", message: `deadline ${ms} ms exceeded during ${tracker.label}` });
    }, ms);
  });
  work.catch(() => undefined);
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

const { profile, headless } = parseArgs(process.argv.slice(2));
const bxDir = path.join(os.homedir(), BX_DIR_NAME);
const runFile = path.join(bxDir, RUN_DIR, `${profile}.json`);
const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(here, "../..", "fixtures", "app");

for (const dir of [RUN_DIR, PROFILES_DIR, SNAPS_DIR, LOGS_DIR]) {
  await mkdir(path.join(bxDir, dir), { recursive: true });
}

// Snaps bx named itself, older than BX_SNAP_DAYS (default 7; 0 keeps them).
void pruneSnaps(path.join(bxDir, SNAPS_DIR)).then((r) => {
  if (r.removed > 0) log(`pruned ${r.removed} snaps older than ${snapDays()} days (${r.bytes} bytes)`);
});

const token = randomBytes(24).toString("hex");
const session = new Session({ profile, headless });
const journal = new Journal();
const bootAt = Date.now();

async function dispatch(cmd: Cmd): Promise<unknown> {
  switch (cmd.cmd) {
    case "open":
      return session.open(cmd);
    case "els":
      return session.els(cmd);
    case "click":
      return session.click(cmd);
    case "fill":
      return session.fill(cmd);
    case "press":
      return session.press(cmd);
    case "select":
      return session.select(cmd);
    case "wait":
      return session.wait(cmd);
    case "expect":
      return session.expect(cmd);
    case "snap":
      return session.snap(cmd);
    case "text":
      return session.text(cmd);
    case "console":
      return session.consoleEntries(cmd);
    case "net":
      return session.netEntries(cmd);
    case "netBody":
      return session.netBody(cmd);
    case "js":
      return session.js(cmd);
    case "drive":
      return session.drive(cmd);
    case "back":
      return session.back(cmd);
    case "reload":
      return session.reload(cmd);
    case "mouse":
      return session.mouse(cmd);
    case "drag":
      return session.drag(cmd);
    case "key":
      return session.key(cmd);
    case "wheel":
      return session.wheel(cmd);
    case "tabs":
      return session.tabs();
    case "tabNew":
      return session.tabNew(cmd);
    case "tabSelect":
      return session.tabSelect(cmd);
    case "tabClose":
      return session.tabClose(cmd);
    case "recordStart":
      return recordStart(session, cmd.slug, cmd);
    case "recordStop":
      return recordStop(session, cmd.outDir, cmd);
    case "recordMark":
      return recordMark(session, cmd.text);
    case "recordSave":
      return recordSave(session, cmd);
    case "recordStatus":
      return recordStatus();
    case "recordDistill":
      return recordDistill(session, cmd.dir);
    case "status":
      return session.status();
    case "actionLog":
      return session.actionLog(cmd);
  }
}

/**
 * One /cmd body, start to finish: schema check, journal, deadline, log line.
 * POST /cmd sends the envelope as-is; POST /argv renders it as CLI output.
 */
async function runCmd(
  body: unknown,
  clientHeader: string | string[] | undefined,
  deadlineHeader: string | string[] | undefined,
): Promise<CmdResult> {
  const parsed = CmdSchema.safeParse(body);
  if (!parsed.success) return fail({ code: "bad_request", message: parsed.error.message });
  const cmd = parsed.data;
  const id = journal.begin(cmd, parseClientTag(clientHeader));
  let failure: BxError | null = null;
  const relaunchesBefore = session.relaunches;
  const startedAt = Date.now();
  const pinned = "tab" in cmd ? cmd.tab : undefined;
  try {
    const tracker = { label: cmd.cmd };
    const work = steps.run(tracker, () => dispatch(cmd));
    const limit = deadlineFor(cmd, deadlineHeader);
    const data = limit === null ? await work : await withDeadline(work, limit, tracker);
    const tab = pinned ?? resultTab(data) ?? session.activeTabId;
    const settled = resultSettle(data);
    log(`${cmd.cmd} ok ${Date.now() - startedAt}ms${tab === undefined ? "" : ` tab=${tab}`}${settled === undefined ? "" : ` settle=${settled}ms`}`);
    const envelope: CmdResult = { ok: true, data };
    if (session.relaunches > relaunchesBefore) envelope.relaunched = true;
    return envelope;
  } catch (err) {
    await session.noteFailure(err);
    failure = toBxError(err);
    const tab = pinned ?? session.activeTabId;
    log(`${cmd.cmd} failed: ${failure.code} ${failure.message} (${Date.now() - startedAt}ms${tab === undefined ? "" : ` tab=${tab}`})`);
    return fail(failure);
  } finally {
    journal.end(id, failure);
    lastActivity = Date.now();
  }
}

async function serveFixture(pathname: string, res: ServerResponse): Promise<void> {
  const rest =
    pathname === "/fixture" || pathname === "/fixture/" ? "" : pathname.slice("/fixture/".length);
  const rel = rest === "" ? "index.html" : decodeURIComponent(rest);
  const full = path.resolve(fixtureDir, rel);
  if (full !== fixtureDir && !full.startsWith(fixtureDir + path.sep)) {
    send(res, 404, "text/plain; charset=utf-8", "not found");
    return;
  }
  let body: Buffer;
  try {
    body = await readFile(full);
  } catch {
    send(res, 404, "text/plain; charset=utf-8", "not found");
    return;
  }
  const type = CONTENT_TYPES[path.extname(full).toLowerCase()] ?? "application/octet-stream";
  send(res, 200, type, body);
}

/** The harness page is written against web Request/Response; bridge to node. */
async function serveHarness(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  handler: (request: Request) => Promise<Response>,
): Promise<void> {
  const method = req.method ?? "GET";
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) for (const item of value) headers.append(key, item);
  }
  const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req);
  const response = await handler(new Request(url.toString(), { method, headers, body }));
  const buf = Buffer.from(await response.arrayBuffer());
  const out: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    out[key] = value;
  });
  res.writeHead(response.status, { ...out, "content-length": buf.length });
  res.end(buf);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname;
  const method = req.method ?? "GET";

  if (pathname === "/health" && method === "GET") {
    const health: HealthResult = { ok: true, profile, browserRunning: session.browserRunning };
    sendJson(res, health);
    return;
  }

  if (pathname === "/fixture" || pathname.startsWith("/fixture/")) {
    await serveFixture(pathname, res);
    return;
  }

  if (pathname.startsWith("/harness")) {
    const route = harnessRoutes[pathname];
    if (route) await serveHarness(req, res, url, route);
    else send(res, 404, "text/plain; charset=utf-8", "not found");
    return;
  }

  const authorized = req.headers["x-bx-token"] === token;

  if (pathname === "/shutdown" && method === "POST") {
    if (!authorized) {
      sendJson(res, fail({ code: "bad_request", message: "bad token" }), 401);
      return;
    }
    sendJson(res, { ok: true, data: null } satisfies CmdResult<null>);
    queueMicrotask(() => {
      void shutdown("shutdown requested");
    });
    return;
  }

  if (pathname === "/cmd" && method === "POST") {
    if (!authorized) {
      sendJson(res, fail({ code: "bad_request", message: "bad token" }), 401);
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, fail({ code: "bad_request", message: "body is not valid JSON" }));
      return;
    }
    sendJson(res, await runCmd(body, req.headers[CLIENT_HEADER], req.headers[DEADLINE_HEADER]));
    return;
  }

  // bx.exe's front door: a whole command line in, {stdout, stderr, exit} out,
  // or {fallback: true} for verbs only the Bun CLI runs (src/argv/serve.ts).
  if (pathname === "/argv" && method === "POST") {
    if (!authorized) {
      sendJson(res, fail({ code: "bad_request", message: "bad token" }), 401);
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, fail({ code: "bad_request", message: "body is not valid JSON" }), 400);
      return;
    }
    sendJson(res, await serveArgv(body, { profile, headless, runCmd }));
    return;
  }

  // The debug surface leaves lastActivity alone on purpose: a monitor polling
  // /debug must not keep an idle daemon alive.
  if (pathname === "/debug" || pathname.startsWith("/debug/")) {
    if (!authorized) {
      sendJson(res, fail({ code: "bad_request", message: "bad token" }), 401);
      return;
    }
    if (pathname === "/debug" && method === "GET") {
      const data = await collectDebug({
        session,
        journal,
        profile,
        headless,
        startedAt: bootAt,
        recording: recordingSlug(),
        lastActivityAt: lastActivity,
        idleLimitMs: idleLimit,
      }, { light: url.searchParams.get("light") === "1" });
      sendJson(res, { ok: true, data } satisfies CmdResult);
      return;
    }
    if (pathname === "/debug/gc" && method === "POST") {
      const data = runGc();
      log(`debug gc: ${data.ran ? `heap ${data.heapBefore} -> ${data.heapAfter}` : "not exposed (no --expose-gc)"}`);
      sendJson(res, { ok: true, data } satisfies CmdResult);
      return;
    }
    if (pathname === "/debug/heapsnapshot" && method === "POST") {
      const data = await heapSnapshot(profile);
      log(`debug heap snapshot: ${data.path} (${data.bytes} bytes, ${data.ms}ms)`);
      sendJson(res, { ok: true, data } satisfies CmdResult);
      return;
    }
  }

  send(res, 404, "text/plain; charset=utf-8", "not found");
}

// Idle reaping. Agents start daemons and walk away (killed runs, forgotten
// profiles), so without this they — and their Chrome — live forever and pile
// up by the dozen. BX_IDLE_MINUTES overrides the default; 0 disables.
const DEFAULT_IDLE_MINUTES = 15;
const IDLE_CHECK_MS = 30_000;
let lastActivity = Date.now();

function idleLimitMs(): number {
  const raw = process.env["BX_IDLE_MINUTES"];
  const minutes = raw === undefined || raw.trim() === "" ? DEFAULT_IDLE_MINUTES : Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) return DEFAULT_IDLE_MINUTES * 60_000;
  return minutes * 60_000;
}

const idleLimit = idleLimitMs();
if (idleLimit > 0) {
  setInterval(() => {
    // A background distill holds the daemon too: exiting would orphan report.md.
    if (journal.inFlightCount > 0 || recordBusy()) return;
    if (Date.now() - lastActivity >= idleLimit) {
      void shutdown(`idle for ${idleLimit / 60_000} min`);
    }
  }, IDLE_CHECK_MS).unref();
}

let shuttingDown = false;
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down: ${reason}`);
  await session.close();
  await unlink(runFile).catch(() => undefined);
  process.exit(0);
}

const server = createServer((req, res) => {
  void handle(req, res).catch((err: unknown) => {
    log(`request failed: ${String(err)}`);
    if (!res.headersSent) sendJson(res, fail(toBxError(err)), 500);
    else res.end();
  });
});
// Commands legitimately run for minutes (browser launch, long waits).
server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;

await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", resolve);
});

// K2: overlap the costly cold-start work with the client's poll and first
// POST. playwright-core takes ~230 ms to import (less once the compile cache
// is warm); Session's own import() then finds it loaded.
void import("playwright-core").catch(() => undefined);

const address = server.address();
const port = typeof address === "object" && address !== null ? address.port : 0;
if (port === 0) throw new Error("http server did not report a port");

const run: RunFile = {
  profile,
  pid: process.pid,
  port,
  token,
  headless,
  startedAt: new Date().toISOString(),
};
await writeFile(runFile, JSON.stringify(run, null, 2));
session.prewarm();

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

log(`bx daemon listening on 127.0.0.1:${port} profile=${profile} headless=${headless}`);
