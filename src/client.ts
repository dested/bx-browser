// Daemon client: locates (or starts) the per-profile daemon and speaks the
// protocol over localhost HTTP. Bun-side only; argv parsing and output
// formatting live in src/argv/ (shared with the daemon's /argv route) and are
// re-exported here for the flows and agent modules.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// No zod here: this module is on every `bx` call's startup path, so it reads
// constants.ts (not protocol.ts, which builds the zod schemas on load) and
// checks the two untrusted shapes it sees (the run file and the response
// envelope) with small hand-written guards.
import { CliError } from "./argv/errors.ts";
import { isRecord, toEnvelope } from "./argv/envelope.ts";
import { deadlineFor, encodeClientTag, modeNoteText } from "./argv/parse.ts";
import {
  BX_DIR_NAME,
  CLIENT_HEADER,
  DEADLINE_HEADER,
  LOGS_DIR,
  PROFILES_DIR,
  RUN_DIR,
  SNAPS_DIR,
} from "./constants.ts";
import type { Cmd, CmdResult, RunFile } from "./protocol.ts";

export { CliError, deadlineFor };
export { isSelectorLike, type MatchOpts, parseTarget } from "./argv/target.ts";
export {
  formatAction,
  formatConsoleEntry,
  formatNetEntry,
  renderEl,
  renderPage,
} from "./argv/format.ts";

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

// ---------------------------------------------------------------------------
// Run file + health
// ---------------------------------------------------------------------------

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
const START_POLL_MS = 15;
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
  const note = modeNoteText(existing, opts);
  if (note !== null) process.stderr.write(note);
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

let clientVia: string | undefined;

/** The bx verb this process is running ("click", "agent", "run"…), for the daemon's client tag. */
export function setClientVia(verb: string): void {
  clientVia = verb;
}

/** Tells the daemon who is driving it, so a monitor can show it (see CLIENT_HEADER). */
function clientTag(): string {
  return encodeClientTag({
    session: process.env["CLAUDE_CODE_SESSION_ID"] || undefined,
    cwd: process.cwd(),
    pid: process.pid,
    via: clientVia,
  });
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
  const longRunning =
    c.cmd === "drive" ||
    c.cmd === "recordStart" ||
    c.cmd === "recordStop" ||
    c.cmd === "recordSave" ||
    c.cmd === "recordDistill";
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
