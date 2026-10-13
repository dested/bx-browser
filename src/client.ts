// Daemon client: locates (or starts) the per-profile daemon, speaks the
// protocol over localhost HTTP, and owns the shared output formatting used by
// both the CLI and the agent driver.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// No zod here: this module is on every `bx` call's startup path, so it reads
// constants.ts (not protocol.ts, which builds the zod schemas on load) and
// checks the two untrusted shapes it sees (the run file and the response
// envelope) with small hand-written guards.
import {
  BX_DIR_NAME,
  CLIENT_HEADER,
  DEADLINE_HEADER,
  DEFAULT_DEADLINE_MS,
  LOGS_DIR,
  PROFILES_DIR,
  RUN_DIR,
  SNAPS_DIR,
} from "./constants.ts";
import type {
  ActionResult,
  BxError,
  ClientTag,
  Cmd,
  CmdResult,
  ConsoleEntry,
  El,
  NetEntry,
  PageInfo,
  RunFile,
  Target,
} from "./protocol.ts";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function bxDir(): string {
  return path.join(os.homedir(), BX_DIR_NAME);
}
export function runDir(): string {
  return path.join(bxDir(), RUN_DIR);
}
export function runFilePath(profile: string): string {
  return path.join(runDir(), `${profile}.json`);
}
export function profilesDir(): string {
  return path.join(bxDir(), PROFILES_DIR);
}
export function logsDir(): string {
  return path.join(bxDir(), LOGS_DIR);
}
export function snapsDir(): string {
  return path.join(bxDir(), SNAPS_DIR);
}

export function ensureDirs(): void {
  for (const dir of [bxDir(), runDir(), profilesDir(), logsDir(), snapsDir()]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export class CliError extends Error {
  constructor(
    public exitCode: number,
    message: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

// ---------------------------------------------------------------------------
// Run file + health
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toRunFile(v: unknown): RunFile | null {
  if (!isRecord(v)) return null;
  const { profile, pid, port, token, headless, startedAt } = v;
  if (
    typeof profile !== "string" ||
    typeof pid !== "number" ||
    typeof port !== "number" ||
    typeof token !== "string" ||
    typeof headless !== "boolean" ||
    typeof startedAt !== "string"
  ) {
    return null;
  }
  return { profile, pid, port, token, headless, startedAt };
}

export function readRunFile(profile: string): RunFile | null {
  let raw: string;
  try {
    raw = fs.readFileSync(runFilePath(profile), "utf8");
  } catch {
    return null;
  }
  try {
    return toRunFile(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function isAlive(run: RunFile): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${run.port}/health`, {
      signal: AbortSignal.timeout(700),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Daemon lifecycle
// ---------------------------------------------------------------------------

const START_TIMEOUT_MS = 15_000;
const START_POLL_MS = 100;
// The daemon's stdout/stderr log rotates when a new daemon starts on a log
// past this size: <profile>.log -> <profile>.1.log (one generation kept).
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

function rotateLog(logPath: string): void {
  try {
    if (fs.statSync(logPath).size < LOG_ROTATE_BYTES) return;
    fs.renameSync(logPath, logPath.replace(/\.log$/, ".1.log"));
  } catch {
    // no log yet, or another process holds it: keep appending
  }
}

function modeNote(existing: RunFile, opts: { headless: boolean; explicit?: boolean }): void {
  if (opts.explicit === true && existing.headless !== opts.headless) {
    process.stderr.write(
      `note: reusing the running ${existing.headless ? "headless" : "headed"} daemon for "${existing.profile}" — \`bx --profile ${existing.profile} stop\` first to change mode\n`,
    );
  }
}

export async function ensureDaemon(
  profile: string,
  // `explicit` marks a caller that actually asked for a mode. Without it an
  // ordinary command adopts whatever daemon is already up, silently — the note
  // would otherwise print on every command run against a headless daemon.
  opts: { headless: boolean; explicit?: boolean },
): Promise<RunFile> {
  ensureDirs();

  const existing = readRunFile(profile);
  if (existing && (await isAlive(existing))) {
    modeNote(existing, opts);
    return existing;
  }

  fs.rmSync(runFilePath(profile), { force: true });

  const logPath = path.join(logsDir(), `${profile}.log`);
  rotateLog(logPath);
  const fd = fs.openSync(logPath, "a");
  try {
    const entry = path.resolve(import.meta.dir, "daemon/daemon.ts");
    // Two constraints here: the daemon must run under Node (Bun on Windows
    // doesn't wire Playwright's CDP pipe fds 3/4, so Chrome starts but the
    // handshake never completes), and it must be spawned via node:child_process
    // with detached:true (Bun.spawn children on Windows die with the parent
    // process, killing the daemon as soon as the CLI exits).
    const { spawn } = await import("node:child_process");
    // --expose-gc lets a monitor force a collection (POST /debug/gc) to tell a
    // real leak from garbage that simply hasn't been collected yet.
    const proc = spawn(
      "node",
      ["--expose-gc", entry, "--profile", profile, ...(opts.headless ? ["--headless"] : [])],
      { detached: true, stdio: ["ignore", fd, fd], windowsHide: true },
    );
    proc.unref();

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await Bun.sleep(START_POLL_MS);
      const run = readRunFile(profile);
      if (run && (await isAlive(run))) return run;
    }
  } finally {
    fs.closeSync(fd);
  }

  throw new CliError(3, `daemon failed to start — see ~/.bx/logs/${profile}.log`);
}

export async function stopDaemon(profile: string): Promise<boolean> {
  const run = readRunFile(profile);
  let stopped = false;
  if (run && (await isAlive(run))) {
    try {
      await fetch(`http://127.0.0.1:${run.port}/shutdown`, {
        method: "POST",
        headers: { "x-bx-token": run.token },
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // The daemon exits while answering; a dropped response still means it went down.
    }
    stopped = true;
  }
  fs.rmSync(runFilePath(profile), { force: true });
  return stopped;
}

/** Stops every daemon that has a run file; stale run files are cleared too. */
export async function stopAllDaemons(): Promise<{ stopped: string[]; cleared: string[] }> {
  const stopped: string[] = [];
  const cleared: string[] = [];
  let files: string[];
  try {
    files = fs.readdirSync(runDir());
  } catch {
    return { stopped, cleared };
  }
  const profiles = files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -".json".length));
  await Promise.all(
    profiles.map(async (profile) => {
      if (await stopDaemon(profile)) stopped.push(profile);
      else cleared.push(profile);
    }),
  );
  return { stopped: stopped.sort(), cleared: cleared.sort() };
}

export function listProfiles(): { name: string; running: boolean }[] {
  const names = new Set<string>();
  const running = new Set<string>();

  try {
    for (const entry of fs.readdirSync(profilesDir(), { withFileTypes: true })) {
      if (entry.isDirectory()) names.add(entry.name);
    }
  } catch {
    // no profiles dir yet
  }
  try {
    for (const file of fs.readdirSync(runDir())) {
      if (!file.endsWith(".json")) continue;
      const name = file.slice(0, -".json".length);
      names.add(name);
      running.add(name);
    }
  } catch {
    // no run dir yet
  }

  return [...names].sort().map((name) => ({ name, running: running.has(name) }));
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

const ERROR_CODES: ReadonlySet<string> = new Set<BxError["code"]>([
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
]);

function isErrorCode(v: unknown): v is BxError["code"] {
  return typeof v === "string" && ERROR_CODES.has(v);
}

function toEl(v: unknown): El | null {
  if (!isRecord(v)) return null;
  const { ref, tag, role, name, state, testid, id } = v;
  if (typeof ref !== "number" || typeof tag !== "string" || typeof role !== "string") return null;
  if (typeof name !== "string" || !Array.isArray(state)) return null;
  return {
    ref,
    tag,
    role,
    name,
    state: state.filter((x): x is string => typeof x === "string"),
    testid: typeof testid === "string" ? testid : undefined,
    id: typeof id === "string" ? id : undefined,
  };
}

type Envelope =
  | { ok: true; data: unknown; relaunched: boolean }
  | { ok: false; error: BxError };

function toEnvelope(v: unknown): Envelope | null {
  if (!isRecord(v)) return null;
  if (v.ok === true && "data" in v) return { ok: true, data: v.data, relaunched: v.relaunched === true };
  if (v.ok !== false || !isRecord(v.error)) return null;
  const { code, message, nearMatches } = v.error;
  if (!isErrorCode(code) || typeof message !== "string") return null;
  const error: BxError = { code, message };
  if (Array.isArray(nearMatches)) {
    error.nearMatches = nearMatches.map(toEl).filter((el): el is El => el !== null);
  }
  return { ok: false, error };
}

let clientVia: string | undefined;

/** The bx verb this process is running ("click", "agent", "run"…), for the daemon's client tag. */
export function setClientVia(verb: string): void {
  clientVia = verb;
}

/** Tells the daemon who is driving it, so a monitor can show it (see CLIENT_HEADER). */
function clientTag(): string {
  const tag: ClientTag = {
    session: process.env["CLAUDE_CODE_SESSION_ID"] || undefined,
    cwd: process.cwd(),
    pid: process.pid,
    via: clientVia,
  };
  return encodeURIComponent(JSON.stringify(tag));
}

/**
 * The daemon-side deadline for a command: an explicit one wins; otherwise a
 * command with its own timeoutMs gets that plus 5 s of headroom, so a long
 * `--timeout` is never cut short by the default.
 */
export function deadlineFor(c: Cmd, explicit?: number): number {
  if (explicit !== undefined) return explicit;
  const own = "timeoutMs" in c && typeof c.timeoutMs === "number" ? c.timeoutMs + 5000 : 0;
  return Math.max(DEFAULT_DEADLINE_MS, own);
}

// The client waits this long past the daemon's own deadline before giving up
// on a daemon that stopped answering altogether.
const CLIENT_GRACE_MS = 5000;

/** True when the request never reached a daemon: the only case that is safe to retry. */
function neverConnected(err: unknown): boolean {
  if (!isRecord(err) && !(err instanceof Error)) return false;
  const code = "code" in err ? err.code : undefined;
  return code === "ConnectionRefused" || code === "ECONNREFUSED" || code === "FailedToOpenSocket";
}

async function post<T>(run: RunFile, c: Cmd, deadlineMs: number): Promise<CmdResult<T>> {
  // drive and recordings carry their own long waits and the daemon sizes their
  // deadline itself, so the client only bounds the commands it set one for.
  const longRunning = c.cmd === "drive" || c.cmd === "recordStart" || c.cmd === "recordStop";
  const res = await fetch(`http://127.0.0.1:${run.port}/cmd`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-bx-token": run.token,
      [CLIENT_HEADER]: clientTag(),
      [DEADLINE_HEADER]: String(deadlineMs),
    },
    body: JSON.stringify(c),
    signal: longRunning ? undefined : AbortSignal.timeout(deadlineMs + CLIENT_GRACE_MS),
  });
  const envelope = toEnvelope(await res.json());
  if (envelope === null) throw new Error(`unexpected daemon response (HTTP ${res.status})`);
  if (!envelope.ok) return { ok: false, error: envelope.error };
  // The envelope is checked; the payload shape is the command's contract in
  // protocol.ts and is trusted here. This is the one typed boundary.
  const data = envelope.data as T;
  return envelope.relaunched ? { ok: true, data, relaunched: true } : { ok: true, data };
}

function unreachable(profile: string, err: unknown): CliError {
  return new CliError(
    3,
    `daemon unreachable for profile "${profile}": ${err instanceof Error ? err.message : String(err)}`,
  );
}

/**
 * Sends one command. Fast path: post straight to the daemon named in the run
 * file, with no /health round trip. Only when that connection is refused (no
 * daemon, or a stale run file) does it discover or spawn one and retry. A
 * request that reached a daemon is never re-sent, so an action can't run twice.
 */
export async function cmd<T>(
  profile: string,
  c: Cmd,
  opts?: { headless?: boolean; deadlineMs?: number },
): Promise<CmdResult<T>> {
  const start = { headless: opts?.headless ?? false, explicit: opts?.headless !== undefined };
  const deadlineMs = deadlineFor(c, opts?.deadlineMs);
  const known = readRunFile(profile);
  if (known !== null) {
    modeNote(known, start);
    try {
      return await post<T>(known, c, deadlineMs);
    } catch (err) {
      if (!neverConnected(err)) throw unreachable(profile, err);
    }
  }
  const run = await ensureDaemon(profile, start);
  try {
    return await post<T>(run, c, deadlineMs);
  } catch (err) {
    throw unreachable(profile, err);
  }
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

const SELECTOR_PREFIXES = ["#", ".", "[", "//", "css=", "xpath="];

export function isSelectorLike(s: string): boolean {
  return SELECTOR_PREFIXES.some((prefix) => s.startsWith(prefix));
}

/** `--exact` / `--first`, applied to text, testid, label and role targets. */
export interface MatchOpts {
  exact?: boolean;
  first?: boolean;
}

const ROLE_TARGET = /^role:([a-z]+)(?::(.*))?$/;

function prefixed(s: string, prefix: string): string | undefined {
  if (!s.startsWith(prefix)) return undefined;
  const rest = s.slice(prefix.length);
  if (rest.length === 0) throw new CliError(2, `${prefix} needs a value, e.g. ${prefix}Save`);
  return rest;
}

/**
 * `@12` is a ref. Bare digits ("2") could be a ref or a button labelled 2, so
 * they go as {ref, orText} and the daemon uses the ref only when it is live in
 * the page's registry. `text:`, `testid:`, `label:` and `role:<role>[:<name>]`
 * name the kind outright. Selector-looking strings are selectors; the rest is text.
 */
export function parseTarget(s: string, match: MatchOpts = {}): Target {
  const at = /^@(\d+)$/.exec(s);
  if (at?.[1] !== undefined) return { ref: Number(at[1]) };
  if (/^\d+$/.test(s)) return { ref: Number(s), orText: s };
  const m = {
    ...(match.exact === true ? { exact: true } : {}),
    ...(match.first === true ? { first: true } : {}),
  };
  const text = prefixed(s, "text:");
  if (text !== undefined) return { text, ...m };
  const testid = prefixed(s, "testid:");
  if (testid !== undefined) return { testid, ...m };
  const label = prefixed(s, "label:");
  if (label !== undefined) return { label, ...m };
  if (s.startsWith("role:")) {
    const role = ROLE_TARGET.exec(s);
    if (role?.[1] === undefined) {
      throw new CliError(2, `bad role target "${s}" — use role:button or role:button:Save`);
    }
    const name = role[2];
    return name === undefined || name === "" ? { role: role[1], ...m } : { role: role[1], name, ...m };
  }
  if (isSelectorLike(s)) return { selector: s };
  return { text: s, ...m };
}

// ---------------------------------------------------------------------------
// Formatting (shared by the CLI and the agent driver)
// ---------------------------------------------------------------------------

export function formatAction(verb: string, detail: string, r: ActionResult): string {
  const lines = [detail ? `✓ ${verb} ${detail}` : `✓ ${verb}`];
  if (r.navigated) lines.push(`→ ${r.page.url} — ${r.page.title}`);
  for (const text of r.consoleErrors) lines.push(`⚠ console: ${text}`);
  const d = r.delta;
  if (d) {
    if (!r.navigated && d.url !== undefined) lines.push(`→ ${d.url}`);
    if (!r.navigated && d.title !== undefined) lines.push(`title ${JSON.stringify(d.title)}`);
    if (d.dialog !== undefined) lines.push(`dialog ${d.dialog}`);
    for (const alert of d.alerts ?? []) lines.push(`! ${alert}`);
    if (d.added > 0 || d.removed > 0) lines.push(`dom +${d.added} −${d.removed}`);
    if (d.focused !== undefined) lines.push(`focus ${d.focused}`);
    if (d.newTab !== undefined) lines.push(`new tab ${d.newTab.id} (background): ${d.newTab.url}`);
  }
  const then = r.then;
  if (then?.els) lines.push("", then.els.rendered.trim() || "(no interactive elements)");
  if (then?.text) lines.push("", then.text.truncated ? `${then.text.text}\n…(truncated)` : then.text.text);
  if (then?.snap) lines.push(`saved ${then.snap.path} (${then.snap.width}x${then.snap.height})`);
  return lines.join("\n");
}

function seconds(ms: number): string {
  return `+${(ms / 1000).toFixed(1)}s`;
}

export function formatConsoleEntry(e: ConsoleEntry): string {
  return `[${e.level}] ${seconds(e.t)} ${e.text}`;
}

// Loopback URLs are shown path-only; anything off-host keeps its origin so a
// stray third-party request is obvious.
function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]") {
      return u.pathname + u.search;
    }
    return url;
  } catch {
    return url;
  }
}

export function formatNetEntry(e: NetEntry): string {
  const status = e.status === 0 ? "ERR" : String(e.status);
  const id = e.id === undefined ? "" : `#${e.id} `;
  return `${id}${e.method} ${status} ${Math.round(e.ms)}ms ${shortUrl(e.url)}`;
}

export function renderEl(el: El): string {
  const state = el.state.length > 0 ? ` (${el.state.join(", ")})` : "";
  return `[${el.ref}] ${el.role || el.tag} ${JSON.stringify(el.name)}${state}`;
}

export function renderPage(p: PageInfo): string {
  return `[${p.index}] ${p.active ? "*" : " "} ${p.title || "(untitled)"} — ${p.url}`;
}
