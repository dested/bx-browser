// bx daemon: one process per profile, holds the browser, speaks localhost HTTP.
// Started detached by the CLI; stdout is redirected to ~/.bx/logs/<profile>.log.
//
//   node src/daemon/daemon.ts --profile <name> [--headless]
//
// Runtime-neutral on purpose (node:http, node:fs — no Bun.* APIs): Playwright
// cannot drive Chrome from Bun, so the daemon must be able to run under Node.
// See the launch notes in session.ts.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BX_DIR_NAME,
  CmdSchema,
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
import { Session } from "./session.ts";
import { harnessRoutes, recordStart, recordStop } from "./record.ts";

const ERROR_CODES: readonly string[] = [
  "target_not_found",
  "stale_ref",
  "timeout",
  "no_page",
  "not_recording",
  "already_recording",
  "browser_launch_failed",
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

const { profile, headless } = parseArgs(process.argv.slice(2));
const bxDir = path.join(os.homedir(), BX_DIR_NAME);
const runFile = path.join(bxDir, RUN_DIR, `${profile}.json`);
const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(here, "../..", "fixtures", "app");

for (const dir of [RUN_DIR, PROFILES_DIR, SNAPS_DIR, LOGS_DIR]) {
  await mkdir(path.join(bxDir, dir), { recursive: true });
}

const token = randomBytes(24).toString("hex");
const session = new Session({ profile, headless });

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
    case "js":
      return session.js(cmd);
    case "back":
      return session.back(cmd);
    case "reload":
      return session.reload(cmd);
    case "tabs":
      return session.tabs();
    case "tabNew":
      return session.tabNew(cmd);
    case "tabSelect":
      return session.tabSelect(cmd);
    case "tabClose":
      return session.tabClose(cmd);
    case "recordStart":
      return recordStart(session, cmd.slug);
    case "recordStop":
      return recordStop(session, cmd.outDir);
    case "status":
      return session.status();
    case "actionLog":
      return session.actionLog(cmd);
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
    const parsed = CmdSchema.safeParse(body);
    if (!parsed.success) {
      sendJson(res, fail({ code: "bad_request", message: parsed.error.message }));
      return;
    }
    const cmd = parsed.data;
    try {
      const data = await dispatch(cmd);
      log(`${cmd.cmd} ok`);
      sendJson(res, { ok: true, data } satisfies CmdResult);
    } catch (err) {
      const error = toBxError(err);
      log(`${cmd.cmd} failed: ${error.code} ${error.message}`);
      sendJson(res, fail(error));
    }
    return;
  }

  send(res, 404, "text/plain; charset=utf-8", "not found");
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

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

log(`bx daemon listening on 127.0.0.1:${port} profile=${profile} headless=${headless}`);
