// Daemon client: locates (or starts) the per-profile daemon, speaks the
// protocol over localhost HTTP, and owns the shared output formatting used by
// both the CLI and the agent driver.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { BX_DIR_NAME, LOGS_DIR, PROFILES_DIR, RUN_DIR, SNAPS_DIR } from "./protocol.ts";
import type {
  ActionResult,
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

const RunFileSchema = z.object({
  profile: z.string(),
  pid: z.number(),
  port: z.number(),
  token: z.string(),
  headless: z.boolean(),
  startedAt: z.string(),
});

export function readRunFile(profile: string): RunFile | null {
  let raw: string;
  try {
    raw = fs.readFileSync(runFilePath(profile), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = RunFileSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
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
    if (opts.explicit === true && existing.headless !== opts.headless) {
      process.stderr.write(
        `note: reusing the running ${existing.headless ? "headless" : "headed"} daemon for "${profile}" — \`bx --profile ${profile} stop\` first to change mode\n`,
      );
    }
    return existing;
  }

  fs.rmSync(runFilePath(profile), { force: true });

  const logPath = path.join(logsDir(), `${profile}.log`);
  const fd = fs.openSync(logPath, "a");
  try {
    const entry = path.resolve(import.meta.dir, "daemon/daemon.ts");
    // Two constraints here: the daemon must run under Node (Bun on Windows
    // doesn't wire Playwright's CDP pipe fds 3/4, so Chrome starts but the
    // handshake never completes), and it must be spawned via node:child_process
    // with detached:true (Bun.spawn children on Windows die with the parent
    // process, killing the daemon as soon as the CLI exits).
    const { spawn } = await import("node:child_process");
    const proc = spawn(
      "node",
      [entry, "--profile", profile, ...(opts.headless ? ["--headless"] : [])],
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

const ElSchema = z.object({
  ref: z.number(),
  tag: z.string(),
  role: z.string(),
  name: z.string(),
  state: z.array(z.string()),
  testid: z.string().optional(),
  id: z.string().optional(),
});

const EnvelopeSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.enum([
        "target_not_found",
        "stale_ref",
        "timeout",
        "no_page",
        "not_recording",
        "already_recording",
        "browser_launch_failed",
        "bad_request",
        "internal",
      ]),
      message: z.string(),
      nearMatches: z.array(ElSchema).optional(),
    }),
  }),
]);

async function post<T>(run: RunFile, c: Cmd): Promise<CmdResult<T>> {
  const res = await fetch(`http://127.0.0.1:${run.port}/cmd`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bx-token": run.token },
    body: JSON.stringify(c),
  });
  const parsed = EnvelopeSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error(`unexpected daemon response (HTTP ${res.status})`);
  if (!parsed.data.ok) return { ok: false, error: parsed.data.error };
  // The envelope is validated; the payload shape is the command's contract in
  // protocol.ts and is trusted here — this is the one typed boundary.
  return { ok: true, data: parsed.data.data as T };
}

export async function cmd<T>(
  profile: string,
  c: Cmd,
  opts?: { headless?: boolean },
): Promise<CmdResult<T>> {
  const start = { headless: opts?.headless ?? false, explicit: opts?.headless !== undefined };
  const run = await ensureDaemon(profile, start);
  try {
    return await post<T>(run, c);
  } catch {
    // The daemon may have died between discovery and the request; respawn once.
    const fresh = await ensureDaemon(profile, start);
    try {
      return await post<T>(fresh, c);
    } catch (err) {
      throw new CliError(
        3,
        `daemon unreachable for profile "${profile}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

const SELECTOR_PREFIXES = ["#", ".", "[", "//", "css=", "xpath="];

export function isSelectorLike(s: string): boolean {
  return SELECTOR_PREFIXES.some((prefix) => s.startsWith(prefix));
}

export function parseTarget(s: string): Target {
  if (/^\d+$/.test(s)) return { ref: Number(s) };
  if (isSelectorLike(s)) return { selector: s };
  return { text: s };
}

// ---------------------------------------------------------------------------
// Formatting (shared by the CLI and the agent driver)
// ---------------------------------------------------------------------------

export function formatAction(verb: string, detail: string, r: ActionResult): string {
  const lines = [detail ? `✓ ${verb} ${detail}` : `✓ ${verb}`];
  if (r.navigated) lines.push(`→ ${r.page.url} — ${r.page.title}`);
  for (const text of r.consoleErrors) lines.push(`⚠ console: ${text}`);
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
  return `${e.method} ${status} ${Math.round(e.ms)}ms ${shortUrl(e.url)}`;
}

export function renderEl(el: El): string {
  const state = el.state.length > 0 ? ` (${el.state.join(", ")})` : "";
  return `[${el.ref}] ${el.role || el.tag} ${JSON.stringify(el.name)}${state}`;
}

export function renderPage(p: PageInfo): string {
  return `[${p.index}] ${p.active ? "*" : " "} ${p.title || "(untitled)"} — ${p.url}`;
}
