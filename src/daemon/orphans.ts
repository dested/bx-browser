// Leftovers a dead daemon can leave behind: a Chrome still holding its
// profile (the next launch then fails with "Opening in existing browser
// session"), the profile's lock files, and screenshots nobody prunes. The
// daemon calls clearProfileLocks on that launch failure; `bx doctor`
// (src/maintenance.ts) reads the same functions to list and fix them.
//
// Node runtime (like the rest of src/daemon): node:* only, no Bun.*.

import { execFile } from "node:child_process";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BX_DIR_NAME, RUN_DIR } from "../constants.ts";

/** Chrome's single-instance markers inside a user-data-dir. */
export const LOCK_FILES = ["SingletonLock", "lockfile", "SingletonCookie", "SingletonSocket"] as const;

export interface ChromeProcess {
  pid: number;
  parentPid: number;
  cmdline: string;
  /** The browser process itself (no `--type=`); renderers and helpers are its children. */
  browser: boolean;
  /** The `--user-data-dir` it was started with, as written on its command line. */
  userDataDir: string | null;
}

export interface ClearResult {
  /** True when anything was cleared, i.e. a retry is worth it. */
  cleared: boolean;
  killed: number[];
  removed: string[];
  /** Why nothing was done, when nothing was. */
  skipped?: string;
}

function run(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/** `--user-data-dir=<dir>` or `--user-data-dir="<dir>"` from a command line. */
export function userDataDirOf(cmdline: string): string | null {
  const m = /--user-data-dir=(?:"([^"]+)"|(\S+))/.exec(cmdline);
  if (!m) return null;
  return m[1] ?? m[2] ?? null;
}

/** Comparable form of a directory path: resolved, no trailing separator, case-folded on Windows. */
export function samePathKey(dir: string): string {
  const resolved = path.resolve(dir.replace(/^"|"$/g, "")).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Win32_Process rows as PowerShell's ConvertTo-Json prints them (one object, or an array). */
export function parseCimProcesses(json: string): ChromeProcess[] {
  const trimmed = json.trim();
  if (trimmed === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const out: ChromeProcess[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const { ProcessId: pid, ParentProcessId: parentPid, CommandLine: cmdline } = row;
    if (typeof pid !== "number" || typeof parentPid !== "number") continue;
    // A process we may not inspect (another user's) has a null command line.
    if (typeof cmdline !== "string") continue;
    out.push({
      pid,
      parentPid,
      cmdline,
      browser: !/\s--type=/.test(cmdline),
      userDataDir: userDataDirOf(cmdline),
    });
  }
  return out;
}

/** Every chrome.exe on the machine that we can read the command line of. Windows only; [] elsewhere. */
export async function listChromes(): Promise<ChromeProcess[]> {
  if (process.platform !== "win32") return [];
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | " +
    "Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress";
  const out = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], 20_000);
  return parseCimProcesses(out);
}

/** Chrome processes (browser and children) started with this user-data-dir. */
export async function findProfileChromes(
  profileDir: string,
  all?: ChromeProcess[],
): Promise<{ pid: number; cmdline: string; browser: boolean; parentPid: number }[]> {
  const want = samePathKey(profileDir);
  const procs = all ?? (await listChromes());
  return procs
    .filter((p) => p.userDataDir !== null && samePathKey(p.userDataDir) === want)
    .map(({ pid, cmdline, browser, parentPid }) => ({ pid, cmdline, browser, parentPid }));
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, we just may not signal it.
    return err instanceof Error && "code" in err && err.code === "EPERM";
  }
}

/** The pid in ~/.bx/run/<profile>.json when that process is still running, else null. */
export async function liveDaemonPid(profile: string, bxDir = path.join(os.homedir(), BX_DIR_NAME)): Promise<number | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path.join(bxDir, RUN_DIR, `${profile}.json`), "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.pid !== "number") return null;
  return pidAlive(parsed.pid) ? parsed.pid : null;
}

/** Kills a process tree. Resolves false when it was already gone or refused. */
export async function killTree(pid: number): Promise<boolean> {
  try {
    if (process.platform === "win32") await run("taskkill", ["/PID", String(pid), "/T", "/F"], 10_000);
    else process.kill(pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

/** Lock files present in a user-data-dir. */
export async function profileLocks(profileDir: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of LOCK_FILES) {
    const file = path.join(profileDir, name);
    try {
      await stat(file);
      found.push(file);
    } catch {
      // not there
    }
  }
  return found;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Frees a profile a dead daemon's Chrome still holds: kills every Chrome
 * started with this user-data-dir, then removes the lock files. Does nothing
 * when a live daemon other than `selfPid` owns the profile, or when a browser
 * on it still has a living parent other than `selfPid`: that Chrome is in use.
 * The daemon passes its own pid, since its own browser is the one that failed
 * to start and anything of its own still holding the profile is a leftover.
 */
export async function clearProfileLocks(profileDir: string, opts: { selfPid?: number } = {}): Promise<ClearResult> {
  const profile = path.basename(profileDir);
  const owner = await liveDaemonPid(profile);
  if (owner !== null && owner !== opts.selfPid) {
    return { cleared: false, killed: [], removed: [], skipped: `a live daemon (pid ${owner}) owns profile "${profile}"` };
  }
  let procs: Awaited<ReturnType<typeof findProfileChromes>>;
  try {
    procs = await findProfileChromes(profileDir);
  } catch {
    // Without the process list, removing the locks alone may still be enough.
    procs = [];
  }
  // A Chrome whose launcher still runs (a test harness driving Playwright on
  // this folder, say) is in use, not orphaned: leave the profile alone.
  const held = procs.find((p) => p.browser && p.parentPid !== opts.selfPid && pidAlive(p.parentPid));
  if (held) {
    return {
      cleared: false,
      killed: [],
      removed: [],
      skipped: `chrome pid ${held.pid} on profile "${profile}" belongs to running pid ${held.parentPid}`,
    };
  }
  const killed: number[] = [];
  // Browser processes first: /T takes their renderers with them.
  for (const p of [...procs].sort((a, b) => Number(b.browser) - Number(a.browser))) {
    if (!pidAlive(p.pid)) continue;
    if (await killTree(p.pid)) killed.push(p.pid);
  }
  if (killed.length > 0) {
    // Chrome releases its lockfile handle as it exits; give it a moment.
    for (let i = 0; i < 20 && procs.some((p) => pidAlive(p.pid)); i++) await sleep(100);
  }
  const removed: string[] = [];
  for (const file of await profileLocks(profileDir)) {
    try {
      await rm(file, { force: true });
      removed.push(file);
    } catch {
      // still held: the retry will say so
    }
  }
  return { cleared: killed.length > 0 || removed.length > 0, killed, removed };
}

/** One line for the daemon log about what clearProfileLocks did. */
export function describeClear(profileDir: string, r: ClearResult): string {
  if (r.skipped !== undefined) return `profile locks not cleared: ${r.skipped}`;
  const parts = [
    r.killed.length > 0 ? `killed orphan chrome pid ${r.killed.join(", ")}` : "no orphan chrome",
    r.removed.length > 0 ? `removed ${r.removed.map((f) => path.basename(f)).join(", ")}` : "no lock files",
  ];
  return `profile ${path.basename(profileDir)} in use: ${parts.join("; ")}`;
}

// ---------------------------------------------------------------------------
// Snaps: `bx snap` without a path writes ~/.bx/snaps/<YYYYMMDD-HHMMSS>.png (or
// .jpg). Nothing else is ever removed from that folder.
// ---------------------------------------------------------------------------

export const SNAP_NAME = /^\d{8}-\d{6}[\w-]*\.(png|jpg)$/;
export const DEFAULT_SNAP_DAYS = 7;

/** BX_SNAP_DAYS, default 7; 0 or less keeps snaps forever. */
export function snapDays(raw = process.env["BX_SNAP_DAYS"]): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_SNAP_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_SNAP_DAYS;
}

/** Deletes bx-named snaps older than `days`. Called once when a daemon starts. */
export async function pruneSnaps(
  snapsDir: string,
  days = snapDays(),
  now = Date.now(),
): Promise<{ removed: number; bytes: number }> {
  const result = { removed: 0, bytes: 0 };
  if (days <= 0) return result;
  const cutoff = now - days * 86_400_000;
  let names: string[];
  try {
    names = await readdir(snapsDir);
  } catch {
    return result;
  }
  for (const name of names) {
    if (!SNAP_NAME.test(name)) continue;
    const file = path.join(snapsDir, name);
    try {
      const s = await stat(file);
      if (!s.isFile() || s.mtimeMs >= cutoff) continue;
      await rm(file, { force: true });
      result.removed++;
      result.bytes += s.size;
    } catch {
      // raced with another daemon's prune, or in use
    }
  }
  return result;
}
