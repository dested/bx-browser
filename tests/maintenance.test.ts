// bx doctor / bx gc and the orphan helpers behind them. No daemon, no
// browser: every filesystem case runs in a throwaway ~/.bx look-alike, and
// the only real system call is the (read-only) Chrome process listing.
//
//   bun test tests/maintenance.test.ts

import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseCimProcesses, pruneSnaps, userDataDirOf } from "../src/daemon/orphans.ts";
import { doctor, formatDoctor, formatGc, gc, planProfile } from "../src/maintenance.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 12, 12);
// A pid far above anything Windows hands out, so it is never alive.
const DEAD_PID = 4_194_000;

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function tmpBx(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bx-maint-"));
  roots.push(root);
  for (const dir of ["run", "profiles", "logs", "snaps", "tmp-video"]) fs.mkdirSync(path.join(root, dir));
  return root;
}

function write(file: string, bytes: number, mtime?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 1));
  if (mtime !== undefined) fs.utimesSync(file, mtime / 1000, mtime / 1000);
}

/** A profile that was last used at `at`. */
function profile(bx: string, name: string, at: number, bytes = 1000): string {
  const dir = path.join(bx, "profiles", name);
  write(path.join(dir, "Default", "Preferences"), bytes, at);
  write(path.join(dir, "Local State"), 10, at);
  return dir;
}

test("userDataDirOf reads quoted and bare --user-data-dir", () => {
  expect(userDataDirOf(`chrome.exe --user-data-dir="C:\\Users\\me\\.bx\\profiles\\a b" --flag`)).toBe(
    "C:\\Users\\me\\.bx\\profiles\\a b",
  );
  expect(userDataDirOf("chrome.exe --type=renderer --user-data-dir=C:\\x\\y --z")).toBe("C:\\x\\y");
  expect(userDataDirOf("chrome.exe --no-sandbox")).toBeNull();
});

test("parseCimProcesses takes one object or an array and skips unreadable rows", () => {
  const one = parseCimProcesses(JSON.stringify({ ProcessId: 5, ParentProcessId: 1, CommandLine: "chrome.exe --user-data-dir=C:\\p" }));
  expect(one).toEqual([{ pid: 5, parentPid: 1, cmdline: "chrome.exe --user-data-dir=C:\\p", browser: true, userDataDir: "C:\\p" }]);
  const many = parseCimProcesses(
    JSON.stringify([
      { ProcessId: 6, ParentProcessId: 5, CommandLine: "chrome.exe --type=gpu-process --user-data-dir=C:\\p" },
      { ProcessId: 7, ParentProcessId: 1, CommandLine: null },
    ]),
  );
  expect(many.map((p) => [p.pid, p.browser])).toEqual([[6, false]]);
  expect(parseCimProcesses("")).toEqual([]);
  expect(parseCimProcesses("not json")).toEqual([]);
});

test("planProfile never deletes default, live, running, kept or recent profiles", () => {
  const opts = { olderThanDays: 14, keep: new Set(["pinned"]) };
  const old = NOW - 30 * DAY;
  const plan = (name: string, extra: { live?: boolean; chrome?: boolean; lastUsed?: number } = {}) =>
    planProfile({ name, lastUsed: extra.lastUsed ?? old, live: extra.live ?? false, chrome: extra.chrome ?? false }, opts, NOW);
  expect(plan("default")).toEqual({ action: "keep", why: "default" });
  expect(plan("a", { live: true })).toEqual({ action: "keep", why: "live daemon" });
  expect(plan("a", { chrome: true })).toEqual({ action: "keep", why: "chrome running" });
  expect(plan("pinned")).toEqual({ action: "keep", why: "keep" });
  expect(plan("a", { lastUsed: NOW - 3 * DAY })).toEqual({ action: "keep", why: "recent" });
  expect(plan("a")).toEqual({ action: "delete", why: "unused 30d" });
});

test("pruneSnaps removes only old bx-named snaps", async () => {
  const dir = path.join(tmpBx(), "snaps");
  write(path.join(dir, "20260801-101010.png"), 100, NOW - 10 * DAY);
  write(path.join(dir, "20260802-101010.jpg"), 50, NOW - 9 * DAY);
  write(path.join(dir, "20261011-101010.png"), 100, NOW - DAY);
  write(path.join(dir, "keepme.png"), 100, NOW - 30 * DAY);
  const r = await pruneSnaps(dir, 7, NOW);
  expect(r).toEqual({ removed: 2, bytes: 150 });
  expect(fs.readdirSync(dir).sort()).toEqual(["20261011-101010.png", "keepme.png"]);
  expect(await pruneSnaps(dir, 0, NOW)).toEqual({ removed: 0, bytes: 0 });
});

test("doctor lists stale run files, locks, big logs and leaked recording scratch, and fixes only with fix", async () => {
  const bx = tmpBx();
  const runFile = path.join(bx, "run", "gone.json");
  fs.writeFileSync(runFile, JSON.stringify({ profile: "gone", pid: DEAD_PID, port: 1, token: "t", headless: true, startedAt: "" }));
  const dir = profile(bx, "crashed", NOW - DAY);
  write(path.join(dir, "lockfile"), 0);
  write(path.join(bx, "logs", "chatty.log"), 5 * 1024 * 1024 + 1);
  write(path.join(bx, "tmp-video", "rec-abc", "page.webm"), 2000);
  fs.utimesSync(path.join(bx, "tmp-video", "rec-abc"), (NOW - 3 * DAY) / 1000, (NOW - 3 * DAY) / 1000);

  const dry = await doctor({ bxDir: bx, now: NOW });
  expect(dry.findings.map((f) => f.kind).sort()).toEqual(["big-log", "lock", "stale-run-file", "tmp-video"]);
  expect(dry.findings.every((f) => f.fixed === undefined)).toBe(true);
  expect(formatDoctor(dry)).toContain("run `bx doctor --fix`");
  // A dry run changes nothing.
  expect(fs.existsSync(runFile)).toBe(true);
  expect(fs.existsSync(path.join(dir, "lockfile"))).toBe(true);

  const fixed = await doctor({ bxDir: bx, now: NOW, fix: true });
  expect(fixed.findings.every((f) => f.fixed === true)).toBe(true);
  expect(fs.existsSync(runFile)).toBe(false);
  expect(fs.existsSync(path.join(dir, "lockfile"))).toBe(false);
  expect(fs.existsSync(path.join(bx, "logs", "chatty.1.log"))).toBe(true);
  expect(fs.existsSync(path.join(bx, "tmp-video", "rec-abc"))).toBe(false);
  expect((await doctor({ bxDir: bx, now: NOW })).findings).toEqual([]);
});

test("gc is a dry run by default and deletes only stale, unprotected profiles with yes", async () => {
  const bx = tmpBx();
  profile(bx, "default", NOW - 90 * DAY);
  profile(bx, "old", NOW - 30 * DAY, 4000);
  profile(bx, "fresh", NOW - 2 * DAY);
  const pinned = profile(bx, "pinned", NOW - 60 * DAY);
  write(path.join(pinned, "Default", "Cache", "data_1"), 3000);
  write(path.join(pinned, "GrShaderCache", "x"), 500);

  const dry = await gc({ bxDir: bx, now: NOW, keep: ["pinned"], caches: true });
  const byName = new Map(dry.profiles.map((p) => [p.name, p]));
  expect(byName.get("old")?.action).toBe("delete");
  expect(byName.get("default")?.why).toBe("default");
  expect(byName.get("fresh")?.why).toBe("recent");
  expect(byName.get("pinned")?.cacheBytes).toBe(3500);
  expect(dry.profiles[0]?.name).toBe("old"); // deletes first
  expect(dry.applied).toBe(false);
  expect(formatGc(dry, { limit: 2, now: NOW })).toContain("dry run: 1 of 4 profiles");
  expect(fs.existsSync(path.join(bx, "profiles", "old"))).toBe(true);

  const done = await gc({ bxDir: bx, now: NOW, keep: ["pinned"], caches: true, yes: true });
  expect(done.applied).toBe(true);
  expect(fs.existsSync(path.join(bx, "profiles", "old"))).toBe(false);
  expect(fs.existsSync(path.join(bx, "profiles", "default"))).toBe(true);
  expect(fs.existsSync(path.join(pinned, "Default", "Cache"))).toBe(false);
  // Cookies and logins live outside the cache folders and survive.
  expect(fs.existsSync(path.join(pinned, "Default", "Preferences"))).toBe(true);
});
