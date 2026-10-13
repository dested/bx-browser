// `bx doctor` and `bx gc`: what dead daemons and old profiles leave behind.
// doctor finds orphaned Chromes, stale run files, profile locks, oversized
// logs and leaked recording scratch; gc lists every profile by size and last
// use and deletes the stale ones. Both are dry runs unless told otherwise
// (`fix` / `yes`). Never touched: the `default` profile (gc), a profile with a
// live daemon, a profile whose Chrome is running, anything in `keep`.
//
// Bun side (the CLI); the process helpers live in daemon/orphans.ts so the
// daemon's own launch retry uses the same code.

import { lstat, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BX_DIR_NAME, LOGS_DIR, PROFILES_DIR, RUN_DIR } from "./constants.ts";
import {
  killTree,
  listChromes,
  pidAlive,
  profileLocks,
  samePathKey,
  type ChromeProcess,
} from "./daemon/orphans.ts";

const DAY_MS = 86_400_000;
/** Matches the CLI's rotate threshold (client.ts). */
const BIG_LOG_BYTES = 5 * 1024 * 1024;
/** A recording's scratch dir older than this belongs to no live recording. */
const TMP_VIDEO_MAX_AGE_MS = DAY_MS;
const TMP_VIDEO_DIR = "tmp-video";

/** Folders `gc --caches` empties: rebuildable, and none hold cookies or logins. */
export const CACHE_DIRS = [
  "Default/Cache",
  "Default/Code Cache",
  "Default/GPUCache",
  "GrShaderCache",
  "ShaderCache",
  "Default/Service Worker/CacheStorage",
] as const;

function defaultBxDir(): string {
  return path.join(os.homedir(), BX_DIR_NAME);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Daemons, as the run files describe them
// ---------------------------------------------------------------------------

export type DaemonState = "live" | "unresponsive" | "stale";

export interface DaemonInfo {
  profile: string;
  file: string;
  pid: number | null;
  state: DaemonState;
}

async function answersHealth(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(700) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Every run file. "unresponsive" (the pid lives but /health doesn't answer) is
 * treated like live everywhere: a busy daemon must never lose its profile.
 */
export async function scanDaemons(bxDir = defaultBxDir()): Promise<DaemonInfo[]> {
  const dir = path.join(bxDir, RUN_DIR);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  return Promise.all(
    names
      .filter((n) => n.endsWith(".json"))
      .map(async (name): Promise<DaemonInfo> => {
        const file = path.join(dir, name);
        const profile = name.slice(0, -".json".length);
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(await readFile(file, "utf8"));
        } catch {
          // unreadable: stale unless something proves otherwise
        }
        const pid = isRecord(parsed) && typeof parsed.pid === "number" ? parsed.pid : null;
        const port = isRecord(parsed) && typeof parsed.port === "number" ? parsed.port : null;
        if (port !== null && (await answersHealth(port))) return { profile, file, pid, state: "live" };
        if (pid !== null && pidAlive(pid)) return { profile, file, pid, state: "unresponsive" };
        return { profile, file, pid, state: "stale" };
      }),
  );
}

/** Profile name for a Chrome whose user-data-dir is a bx profile, else null. */
function bxProfileOf(proc: ChromeProcess, profilesKey: string): string | null {
  if (proc.userDataDir === null) return null;
  const key = samePathKey(proc.userDataDir);
  const prefix = profilesKey + (process.platform === "win32" ? "\\" : "/");
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  if (rest === "" || /[\\/]/.test(rest)) return null;
  // The key is case-folded on Windows; recover the name as written.
  return path.basename(proc.userDataDir.replace(/^"|"$/g, "").replace(/[\\/]+$/, ""));
}

// ---------------------------------------------------------------------------
// Links (R2b). A symlink or junction under ~/.bx can point anywhere (a repo,
// another drive), so nothing here follows, sizes or deletes through one: it is
// reported as `skipped: link` instead. Node and Bun report a Windows junction
// (a directory reparse point) as a symbolic link from both lstat and Dirent,
// so isSymbolicLink() covers symlinks and junctions alike.
// ---------------------------------------------------------------------------

export async function isLink(p: string): Promise<boolean> {
  try {
    return (await lstat(p)).isSymbolicLink();
  } catch {
    return false;
  }
}

/** True when `rel` (forward slashes) under `root` is a link or passes through one. */
export async function crossesLink(root: string, rel: string): Promise<boolean> {
  let at = root;
  for (const part of rel.split("/")) {
    at = path.join(at, part);
    if (await isLink(at)) return true;
  }
  return false;
}

/** A directory's subdirectories, with links split out (never treated as directories). */
async function listDirs(dir: string): Promise<{ dirs: string[]; links: string[] }> {
  const out = { dirs: [] as string[], links: [] as string[] };
  try {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) out.links.push(e.name);
      else if (e.isDirectory()) out.dirs.push(e.name);
    }
  } catch {
    // missing: nothing to list
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sizes
// ---------------------------------------------------------------------------

/** Bytes under a directory; unreadable entries count as zero. Links count as zero and are never entered. */
export async function dirBytes(dir: string, checkRoot = true): Promise<number> {
  if (checkRoot && (await isLink(dir))) return 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const sizes = await Promise.all(
    entries.map(async (e): Promise<number> => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return dirBytes(full, false);
      if (!e.isFile()) return 0;
      try {
        return (await stat(full)).size;
      } catch {
        return 0;
      }
    }),
  );
  let total = 0;
  for (const n of sizes) total += n;
  return total;
}

async function mtimeOf(file: string): Promise<number | null> {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

export type FindingKind =
  | "orphan-chrome"
  | "stray-chrome"
  | "stale-run-file"
  | "lock"
  | "big-log"
  | "tmp-video"
  | "link"; // a profile or tmp-video entry that is a symlink/junction: skipped, never fixed

export interface Finding {
  kind: FindingKind;
  profile?: string;
  detail: string;
  path?: string;
  pid?: number;
  bytes?: number;
  /** --fix acts on it. stray-chrome (a second Chrome beside a live daemon) is report-only. */
  fixable: boolean;
  /** Set when --fix ran: whether the fix worked. */
  fixed?: boolean;
}

export interface DoctorReport {
  findings: Finding[];
  daemons: { live: number; unresponsive: number; stale: number };
  chromes: number; // Chrome browser processes on bx profiles
  fix: boolean;
}

export interface DoctorOptions {
  fix?: boolean;
  bxDir?: string;
  now?: number;
}

export async function doctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const bxDir = opts.bxDir ?? defaultBxDir();
  const fix = opts.fix === true;
  const now = opts.now ?? Date.now();
  const profilesDir = path.join(bxDir, PROFILES_DIR);
  const findings: Finding[] = [];

  const daemons = await scanDaemons(bxDir);
  const owner = new Map<string, DaemonInfo>();
  // Keys are case-folded: Windows paths (and so profile names) are case-insensitive.
  for (const d of daemons) if (d.state !== "stale") owner.set(d.profile.toLowerCase(), d);

  // Stale run files: neither the port nor the pid answers.
  for (const d of daemons) {
    if (d.state !== "stale") continue;
    findings.push({
      kind: "stale-run-file",
      profile: d.profile,
      path: d.file,
      detail: `run file for "${d.profile}" points at a dead daemon${d.pid === null ? "" : ` (pid ${d.pid})`}`,
      fixable: true,
    });
  }

  // Chromes on bx profiles: orphans have no live daemon; strays sit beside one.
  const profilesKey = samePathKey(profilesDir);
  const chromes = (await listChromes()).filter((p) => bxProfileOf(p, profilesKey) !== null);
  const pidsByProfile = new Map<string, Set<number>>();
  for (const p of chromes) {
    const name = bxProfileOf(p, profilesKey);
    if (name === null) continue;
    const key = name.toLowerCase();
    const set = pidsByProfile.get(key) ?? new Set<number>();
    set.add(p.pid);
    pidsByProfile.set(key, set);
  }
  const browsers = chromes.filter((p) => p.browser);
  for (const p of chromes) {
    const name = bxProfileOf(p, profilesKey);
    if (name === null) continue;
    // A helper whose browser process is alive goes down with that browser.
    if (!p.browser && pidsByProfile.get(name.toLowerCase())?.has(p.parentPid)) continue;
    const daemon = owner.get(name.toLowerCase());
    if (daemon && p.parentPid === daemon.pid) continue;
    if (!daemon && !pidAlive(p.parentPid)) {
      // Its launcher is gone: the classic dead-daemon leftover.
      findings.push({
        kind: "orphan-chrome",
        profile: name,
        pid: p.pid,
        detail: `chrome pid ${p.pid}${p.browser ? "" : " (helper)"} holds profile "${name}" and its daemon is gone`,
        fixable: true,
      });
    } else if (p.browser) {
      // Something else still runs it (a test harness, a second launcher): report only.
      findings.push({
        kind: "stray-chrome",
        profile: name,
        pid: p.pid,
        detail: daemon
          ? `chrome pid ${p.pid} holds profile "${name}" beside its daemon (pid ${daemon.pid ?? "?"}), under pid ${p.parentPid}`
          : `chrome pid ${p.pid} holds profile "${name}" under running pid ${p.parentPid}, not a bx daemon`,
        fixable: false,
      });
    }
  }

  // Locks left in profiles nobody holds. Linked profiles are reported, never entered.
  const { dirs: profileNames, links: profileLinks } = await listDirs(profilesDir);
  for (const name of profileLinks) {
    const p = path.join(profilesDir, name);
    findings.push({ kind: "link", profile: name, path: p, detail: `skipped: link ${p}`, fixable: false });
  }
  await Promise.all(
    profileNames.map(async (name) => {
      if (owner.has(name.toLowerCase()) || pidsByProfile.has(name.toLowerCase())) return;
      for (const file of await profileLocks(path.join(profilesDir, name))) {
        findings.push({ kind: "lock", profile: name, path: file, detail: `stale ${path.basename(file)} in profile "${name}"`, fixable: true });
      }
    }),
  );

  // Logs past the rotate size. A running daemon has its log open: report only.
  const logsDir = path.join(bxDir, LOGS_DIR);
  let logNames: string[] = [];
  try {
    logNames = await readdir(logsDir);
  } catch {
    // no logs yet
  }
  for (const name of logNames) {
    if (!name.endsWith(".log") || name.endsWith(".1.log")) continue;
    const file = path.join(logsDir, name);
    const bytes = (await stat(file).catch(() => null))?.size ?? 0;
    if (bytes < BIG_LOG_BYTES) continue;
    const profile = name.slice(0, -".log".length);
    const running = owner.has(profile.toLowerCase());
    findings.push({
      kind: "big-log",
      profile,
      path: file,
      bytes,
      detail: `${name} is ${formatBytes(bytes)}${running ? " (daemon running: rotates on its next start)" : ""}`,
      fixable: !running,
    });
  }

  // Recording scratch that outlived its recording.
  const tmpRoot = path.join(bxDir, TMP_VIDEO_DIR);
  const { dirs: tmpNames, links: tmpLinks } = await listDirs(tmpRoot);
  for (const name of tmpLinks) {
    const p = path.join(tmpRoot, name);
    findings.push({ kind: "link", path: p, detail: `skipped: link ${p}`, fixable: false });
  }
  for (const name of tmpNames) {
    const dir = path.join(tmpRoot, name);
    const m = await mtimeOf(dir);
    if (m === null || now - m < TMP_VIDEO_MAX_AGE_MS) continue;
    const bytes = await dirBytes(dir);
    findings.push({ kind: "tmp-video", path: dir, bytes, detail: `leaked recording scratch ${name} (${formatBytes(bytes)})`, fixable: true });
  }

  if (fix) {
    for (const f of findings) {
      if (!f.fixable) continue;
      f.fixed = await applyFix(f, logsDir);
    }
  }

  return {
    findings,
    daemons: {
      live: daemons.filter((d) => d.state === "live").length,
      unresponsive: daemons.filter((d) => d.state === "unresponsive").length,
      stale: daemons.filter((d) => d.state === "stale").length,
    },
    chromes: browsers.length,
    fix,
  };
}

async function applyFix(f: Finding, logsDir: string): Promise<boolean> {
  try {
    switch (f.kind) {
      case "orphan-chrome":
        return f.pid !== undefined && (!pidAlive(f.pid) || (await killTree(f.pid)));
      case "stale-run-file":
      case "lock":
        if (f.path === undefined) return false;
        await rm(f.path, { force: true });
        return true;
      case "big-log": {
        if (f.path === undefined || f.profile === undefined) return false;
        await rename(f.path, path.join(logsDir, `${f.profile}.1.log`));
        return true;
      }
      case "tmp-video":
        // Re-checked at delete time: it may have become a link since the scan.
        if (f.path === undefined || (await isLink(f.path))) return false;
        await rm(f.path, { recursive: true, force: true, maxRetries: 2 });
        return true;
      case "stray-chrome":
      case "link":
        return false;
    }
  } catch {
    return false;
  }
}

export function formatDoctor(r: DoctorReport): string {
  const lines: string[] = [];
  const d = r.daemons;
  lines.push(
    `daemons: ${d.live} live${d.unresponsive > 0 ? `, ${d.unresponsive} unresponsive` : ""}, ${d.stale} stale run file${d.stale === 1 ? "" : "s"} · chrome on bx profiles: ${r.chromes}`,
  );
  if (r.findings.length === 0) {
    lines.push("ok: nothing to fix");
    return lines.join("\n");
  }
  for (const f of r.findings) {
    const mark = f.fixed === undefined ? (f.fixable ? "-" : "!") : f.fixed ? "fixed" : "FAILED";
    lines.push(`${mark} ${f.kind}: ${f.detail}`);
  }
  const fixable = r.findings.filter((f) => f.fixable).length;
  if (!r.fix) {
    lines.push(fixable > 0 ? `${fixable} fixable; run \`bx doctor --fix\` to fix them` : "nothing fixable automatically");
  } else {
    const failed = r.findings.filter((f) => f.fixed === false).length;
    lines.push(failed === 0 ? `fixed ${fixable}` : `fixed ${fixable - failed}, ${failed} failed`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// gc
// ---------------------------------------------------------------------------

export interface GcOptions {
  /** Delete profiles unused for longer than this. Default 14. */
  olderThanDays?: number;
  /** Also empty the cache folders (CACHE_DIRS) of every profile that stays. */
  caches?: boolean;
  /** Actually delete. Without it, gc only reports. */
  yes?: boolean;
  /** Profile names never to delete. */
  keep?: string[];
  bxDir?: string;
  now?: number;
}

/** skip: the profile entry is a symlink/junction (why "link"); gc never enters or deletes it. */
export type GcAction = "delete" | "keep" | "skip";

export interface GcProfile {
  name: string;
  bytes: number;
  /** Newest of Default/Preferences, Local State and the profile's log; the folder's own mtime if none exist. */
  lastUsed: number;
  action: GcAction;
  /** Why it stays: "default", "live daemon", "chrome running", "keep", "recent"; "link" for a skip. */
  why: string;
  /** With caches: bytes in CACHE_DIRS (what --caches frees from a kept profile). */
  cacheBytes?: number;
  /** With caches: the CACHE_DIRS entries that are real folders (none passing through a link). */
  cacheDirs?: string[];
  /** With yes: whether the delete / cache clear went through. */
  done?: boolean;
  error?: string;
}

export interface GcReport {
  profiles: GcProfile[]; // deletes first (oldest first), then kept (oldest first), then links skipped
  totalBytes: number;
  deleteBytes: number;
  cacheBytes: number; // reclaimable from kept profiles' caches (only with caches)
  olderThanDays: number;
  applied: boolean;
}

export interface GcCandidate {
  name: string;
  lastUsed: number;
  live: boolean;
  chrome: boolean;
}

/** The pure decision: what happens to one profile. */
export function planProfile(
  c: GcCandidate,
  opts: { olderThanDays: number; keep: ReadonlySet<string> },
  now: number,
): { action: "delete" | "keep"; why: string } {
  if (c.name === "default") return { action: "keep", why: "default" };
  if (c.live) return { action: "keep", why: "live daemon" };
  if (c.chrome) return { action: "keep", why: "chrome running" };
  if (opts.keep.has(c.name)) return { action: "keep", why: "keep" };
  if (now - c.lastUsed <= opts.olderThanDays * DAY_MS) return { action: "keep", why: "recent" };
  return { action: "delete", why: `unused ${Math.floor((now - c.lastUsed) / DAY_MS)}d` };
}

async function lastUsedOf(profileDir: string, logFile: string): Promise<number> {
  const times = await Promise.all([
    mtimeOf(path.join(profileDir, "Default", "Preferences")),
    mtimeOf(path.join(profileDir, "Local State")),
    mtimeOf(logFile),
  ]);
  let newest: number | null = null;
  for (const t of times) if (t !== null && (newest === null || t > newest)) newest = t;
  return newest ?? (await mtimeOf(profileDir)) ?? 0;
}

/** Runs `work` over `items` with at most `limit` in flight. */
async function pool<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      const item = items[i];
      if (item !== undefined) out[i] = await work(item);
    }
  });
  await Promise.all(lanes);
  return out;
}

const GC_CONCURRENCY = 8;

export async function gc(opts: GcOptions = {}): Promise<GcReport> {
  const bxDir = opts.bxDir ?? defaultBxDir();
  const now = opts.now ?? Date.now();
  const olderThanDays = opts.olderThanDays ?? 14;
  const keep: ReadonlySet<string> = new Set(opts.keep ?? []);
  const profilesDir = path.join(bxDir, PROFILES_DIR);
  const logsDir = path.join(bxDir, LOGS_DIR);

  const { dirs: names, links } = await listDirs(profilesDir);

  const live = new Set((await scanDaemons(bxDir)).filter((d) => d.state !== "stale").map((d) => d.profile.toLowerCase()));
  const profilesKey = samePathKey(profilesDir);
  const chrome = new Set<string>();
  for (const p of await listChromes()) {
    const name = bxProfileOf(p, profilesKey);
    if (name !== null) chrome.add(name.toLowerCase());
  }

  const profiles = await pool(names, GC_CONCURRENCY, async (name): Promise<GcProfile> => {
    const dir = path.join(profilesDir, name);
    const [bytes, lastUsed] = await Promise.all([dirBytes(dir), lastUsedOf(dir, path.join(logsDir, `${name}.log`))]);
    const plan = planProfile(
      { name, lastUsed, live: live.has(name.toLowerCase()), chrome: chrome.has(name.toLowerCase()) },
      { olderThanDays, keep },
      now,
    );
    const entry: GcProfile = { name, bytes, lastUsed, ...plan };
    // A running Chrome has its caches open; leave those alone too.
    if (opts.caches && plan.action === "keep" && plan.why !== "live daemon" && plan.why !== "chrome running") {
      entry.cacheDirs = [];
      for (const rel of CACHE_DIRS) if (!(await crossesLink(dir, rel))) entry.cacheDirs.push(rel);
      const sizes = await Promise.all(entry.cacheDirs.map((rel) => dirBytes(path.join(dir, rel))));
      entry.cacheBytes = sizes.reduce((a, b) => a + b, 0);
    }
    return entry;
  });
  for (const name of links) profiles.push({ name, bytes: 0, lastUsed: 0, action: "skip", why: "link" });

  if (opts.yes) {
    await pool(profiles, GC_CONCURRENCY, async (p) => {
      const dir = path.join(profilesDir, p.name);
      try {
        if (p.action === "skip") return;
        // Re-checked at delete time: a folder swapped for a link since the scan is skipped.
        if (await isLink(dir)) {
          p.action = "skip";
          p.why = "link";
          return;
        }
        if (p.action === "delete") {
          await rm(dir, { recursive: true, force: true, maxRetries: 2 });
          p.done = true;
        } else if (p.cacheBytes !== undefined && p.cacheBytes > 0) {
          for (const rel of p.cacheDirs ?? []) {
            if (await crossesLink(dir, rel)) continue;
            await rm(path.join(dir, rel), { recursive: true, force: true, maxRetries: 2 });
          }
          p.done = true;
        }
      } catch (err) {
        p.done = false;
        p.error = err instanceof Error ? err.message : String(err);
      }
    });
  }

  const order: Record<GcAction, number> = { delete: 0, keep: 1, skip: 2 };
  profiles.sort((a, b) => order[a.action] - order[b.action] || a.lastUsed - b.lastUsed || a.name.localeCompare(b.name));
  let totalBytes = 0;
  let deleteBytes = 0;
  let cacheBytes = 0;
  for (const p of profiles) {
    totalBytes += p.bytes;
    if (p.action === "delete") deleteBytes += p.bytes;
    else cacheBytes += p.cacheBytes ?? 0;
  }
  return { profiles, totalBytes, deleteBytes, cacheBytes, olderThanDays, applied: opts.yes === true };
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** `limit`: profile rows to print (deletes first); the totals always print. */
export function formatGc(r: GcReport, opts: { limit?: number; now?: number } = {}): string {
  const now = opts.now ?? Date.now();
  const rows = opts.limit === undefined ? r.profiles : r.profiles.slice(0, opts.limit);
  const width = Math.max(4, ...rows.map((p) => p.name.length));
  const lines = rows.map((p) => {
    if (p.action === "skip") return `skipped: link  ${p.name}`;
    const age = Math.floor((now - p.lastUsed) / DAY_MS);
    const verb = p.action === "delete" ? (r.applied ? (p.done ? "deleted" : "FAILED") : "delete") : "keep";
    const cache = p.cacheBytes !== undefined && p.cacheBytes > 0 ? ` · caches ${formatBytes(p.cacheBytes)}` : "";
    const why = p.action === "keep" ? ` (${p.why})` : "";
    const err = p.error === undefined ? "" : ` — ${p.error}`;
    return `${verb.padEnd(7)} ${p.name.padEnd(width)} ${formatBytes(p.bytes).padStart(9)}  last used ${day(p.lastUsed)} (${age}d)${why}${cache}${err}`;
  });
  if (opts.limit !== undefined && r.profiles.length > rows.length) lines.push(`… ${r.profiles.length - rows.length} more`);
  const deletes = r.profiles.filter((p) => p.action === "delete").length;
  const summary = r.applied
    ? `deleted ${r.profiles.filter((p) => p.action === "delete" && p.done).length} of ${deletes} profiles unused > ${r.olderThanDays}d (${formatBytes(r.deleteBytes)})`
    : `dry run: ${deletes} of ${r.profiles.length} profiles unused > ${r.olderThanDays}d would be deleted (${formatBytes(r.deleteBytes)} of ${formatBytes(r.totalBytes)}); add --yes to delete`;
  lines.push(summary);
  if (r.cacheBytes > 0) lines.push(`${r.applied ? "cleared" : "caches in kept profiles:"} ${formatBytes(r.cacheBytes)}${r.applied ? " of caches" : ""}`);
  return lines.join("\n");
}
