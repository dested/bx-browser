// Recording: Playwright captures video across a relaunch cycle, then the webm
// is distilled into an agent-ready package by video-to-prompt running inside
// the browser bx already controls (the library is browser-only by design).
//
// bx's action log stands in for narration — the recording has no audio track,
// so "clicked Save changes" becomes the timed transcript and the report reads
// as a narrated walkthrough.
//
// Runtime-neutral (node:* only): the daemon runs under Node, so the harness
// bundle is built by shelling out to `bun scripts/build-harness.ts`.

import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BX_DIR_NAME, RUN_DIR, type RecordStartResult, type RecordStopResult } from "../protocol.ts";
import type { Session } from "./session.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const HARNESS_SRC = path.join(repoRoot, "src", "daemon", "harness", "harness.ts");
const HARNESS_BUNDLE = path.join(repoRoot, "dist", "harness.js");

const VIDEO_SIZE = { width: 1280, height: 800 };
const DISTILL_TIMEOUT_MS = 180_000;

interface RecordingState {
  slug: string;
  startedAtMs: number;
  actionLogStartIndex: number;
  videoTmpDir: string;
}

/** One recording at a time — the daemon owns a single browser context. */
let state: RecordingState | null = null;

// ---------------------------------------------------------------------------
// Tab selection (pure — unit-tested in tests/record.test.ts)
// ---------------------------------------------------------------------------

/** A page's flushed webm, tagged with the tab id that produced it. */
export interface VideoCandidate {
  tab: number;
  file: string;
  bytes: number;
}

/**
 * Which tab's video to ship. Playwright's recordVideo writes one webm per page
 * in the context; picking the largest file silently loses to a looping
 * animation on an idle tab (that encodes bigger than a busy tab of static
 * pages). Select by ACTION ACTIVITY instead — the tab that saw the most log
 * entries — and let bytes break ties only for a passive, action-free recording.
 */
export type VideoSelection =
  | { ok: true; source: VideoCandidate; actions: number }
  | { ok: false; reason: "no-video" }
  | { ok: false; reason: "wrong-tab"; drivenActions: number };

/** Tally action-log entries per acting tab; entries with no page are ignored. */
export function tallyActionsByTab(entries: readonly { tab?: number }[]): Map<number, number> {
  const byTab = new Map<number, number>();
  for (const entry of entries) {
    if (entry.tab === undefined) continue;
    byTab.set(entry.tab, (byTab.get(entry.tab) ?? 0) + 1);
  }
  return byTab;
}

export function selectRecordedVideo(
  candidates: readonly VideoCandidate[],
  actionsByTab: Map<number, number>,
): VideoSelection {
  const scored = candidates.map((c) => ({ ...c, actions: actionsByTab.get(c.tab) ?? 0 }));
  scored.sort((a, b) => b.actions - a.actions || b.bytes - a.bytes);
  const source = scored[0];
  if (!source || source.bytes === 0) return { ok: false, reason: "no-video" };

  // Loud guard: some tab WAS driven this recording, yet the winning video's tab
  // saw zero actions — the driven tab's video is missing, so a passive tab won.
  // Fail rather than silently ship a blank/idle video (the byte-heuristic bug).
  if (actionsByTab.size > 0 && source.actions === 0) {
    let drivenActions = 0;
    for (const n of actionsByTab.values()) drivenActions += n;
    return { ok: false, reason: "wrong-tab", drivenActions };
  }
  return { ok: true, source, actions: source.actions };
}

export function recordingSlug(): string | null {
  return state?.slug ?? null;
}

/** Keyed by full pathname (e.g. "/harness", "/harness/video"). */
export const harnessRoutes: Record<string, (req: Request) => Promise<Response>> = {};

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

interface CommandResult {
  code: number;
  output: string;
}

function runCommand(cmd: string, args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    // Windows `spawn` does not apply PATHEXT, so `bun` alone would not resolve.
    // windowsHide keeps `shell:true` from flashing a cmd.exe window whenever a
    // helper (ffmpeg install, harness rebuild) fires during a record.
    const proc = spawn(cmd, args, { cwd, shell: process.platform === "win32", windowsHide: true });
    let output = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    proc.on("error", (err) => resolve({ code: -1, output: `${output}${String(err)}` }));
    proc.on("close", (code) => resolve({ code: code ?? -1, output }));
  });
}

function tail(text: string, lines = 5): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ---------------------------------------------------------------------------
// ffmpeg — playwright-core with channel:chrome does not ship it, but
// recordVideo needs it.
// ---------------------------------------------------------------------------

function playwrightCacheDirs(): string[] {
  const configured = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (configured !== undefined && configured !== "" && configured !== "0") return [configured];
  const home = os.homedir();
  return [
    path.join(home, "AppData", "Local", "ms-playwright"),
    path.join(home, "Library", "Caches", "ms-playwright"),
    path.join(home, ".cache", "ms-playwright"),
  ];
}

async function hasFfmpeg(): Promise<boolean> {
  for (const dir of playwrightCacheDirs()) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((entry) => entry.isDirectory() && entry.name.startsWith("ffmpeg"))) return true;
  }
  return false;
}

async function ensureFfmpeg(): Promise<void> {
  if (await hasFfmpeg()) return;
  log("playwright ffmpeg missing — installing (needed for video capture)");
  const result = await runCommand("bun", ["x", "playwright-core", "install", "ffmpeg"], repoRoot);
  if (result.code !== 0 || !(await hasFfmpeg())) {
    throw {
      code: "internal",
      message: "recording needs playwright's ffmpeg — run: bun x playwright-core install ffmpeg",
    };
  }
  log("ffmpeg installed");
}

// ---------------------------------------------------------------------------
// Harness bundle
// ---------------------------------------------------------------------------

async function mtimeMs(file: string): Promise<number | null> {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

async function ensureHarnessBundle(): Promise<void> {
  const bundle = await mtimeMs(HARNESS_BUNDLE);
  const source = await mtimeMs(HARNESS_SRC);
  if (bundle !== null && source !== null && bundle >= source) return;

  log("building harness bundle");
  const result = await runCommand("bun", ["scripts/build-harness.ts"], repoRoot);
  if (result.code !== 0 || (await mtimeMs(HARNESS_BUNDLE)) === null) {
    throw {
      code: "internal",
      message: `harness bundle failed: ${tail(result.output)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const HARNESS_HTML =
  '<!doctype html><meta charset="utf-8"><title>bx distill</title>' +
  '<pre id="log"></pre><script type="module" src="/harness.js"></script>';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * The harness names its own output paths; keep them inside the package dir.
 * Rejects absolute paths, drive letters and any `..` segment.
 */
function safeJoin(root: string, rel: string): string | null {
  if (rel === "" || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return null;
  const normalized = path.normalize(rel);
  if (normalized.split(/[\\/]/).includes("..")) return null;
  // Both sides must be resolved before comparing: callers pass forward-slash
  // paths on Windows, which would never prefix-match a resolved path.
  const base = path.resolve(root);
  const full = path.resolve(base, normalized);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

function parseResultBody(value: unknown): { path: string; base64: string } | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("path" in value) || !("base64" in value)) return null;
  const { path: rel, base64 } = value;
  if (typeof rel !== "string" || typeof base64 !== "string") return null;
  return { path: rel, base64 };
}

function messageOf(value: unknown): string {
  if (typeof value === "object" && value !== null && "message" in value) {
    const { message } = value;
    if (typeof message === "string") return message;
  }
  return "unknown harness error";
}

// ---------------------------------------------------------------------------
// Daemon port (the harness page fetches over HTTP, so it needs the real port)
// ---------------------------------------------------------------------------

async function daemonPort(profile: string): Promise<number> {
  const file = path.join(os.homedir(), BX_DIR_NAME, RUN_DIR, `${profile}.json`);
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
  if (typeof parsed === "object" && parsed !== null && "port" in parsed) {
    const { port } = parsed;
    if (typeof port === "number") return port;
  }
  throw { code: "internal", message: `could not read daemon port from ${file}` };
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export async function recordStart(session: Session, slug: string): Promise<RecordStartResult> {
  if (state) throw { code: "already_recording", message: `already recording "${state.slug}"` };

  await ensureFfmpeg();

  const videoTmpDir = path.join(
    os.homedir(),
    BX_DIR_NAME,
    "tmp-video",
    `${slug}-${Date.now().toString(36)}`,
  );
  await mkdir(videoTmpDir, { recursive: true });

  // NOTE: the persistent console window that appears during a record is
  // Playwright's own recordVideo ffmpeg encoder — bx cannot pass windowsHide
  // into that internal spawn. The real fix is to drop recordVideo and capture
  // via CDP Page.startScreencast on a single chosen page + our own ffmpeg
  // (windowsHide:true), which would ALSO make Bug 1 structurally impossible
  // (record one known tab instead of "record every page then guess"). See
  // decisions.md. Not done here — this task keeps recordVideo and selects the
  // driven tab by action activity in recordStop.
  await session.relaunch({ recordVideo: { dir: videoTmpDir, size: VIDEO_SIZE } });

  const actionLogStartIndex = session.actions.nextIndex;
  // The capped log must not trim this recording's transcript away mid-take.
  session.actions.holdFrom(actionLogStartIndex);
  state = {
    slug,
    startedAtMs: Date.now(),
    actionLogStartIndex,
    videoTmpDir,
  };
  log(`recording "${slug}" → ${videoTmpDir}`);
  return { slug };
}

export async function recordStop(session: Session, outDir: string): Promise<RecordStopResult> {
  const current = state;
  if (!current) throw { code: "not_recording", message: "not recording" };

  // 1. The action log for this recording becomes the transcript. Once copied,
  //    the log may trim again.
  const entries = session.actions.since(current.actionLogStartIndex);
  session.actions.holdFrom(null);
  const origin = session.logTimeOrigin;
  const segments = entries.map((entry) => ({
    t: Math.max(0, origin + entry.t - current.startedAtMs),
    text: entry.text,
  }));

  // 2. Grab the video handles before the context goes away: closing it is what
  //    flushes the webm to disk. Pair each page's video with its tab id NOW —
  //    the relaunch below closes the pages, and the tab id is what lets us pick
  //    the tab that was actually driven (step 3).
  const context = session.liveContext;
  const pageVideos = (context?.pages() ?? []).map((page) => ({
    tab: session.tabIdOf(page),
    video: page.video(),
  }));

  await session.relaunch();

  // 3. Select the captured tab by ACTION ACTIVITY, not byte size (see
  //    selectRecordedVideo). Resolve each page's flushed webm, then let the
  //    pure selector pick the driven tab and flag a wrong-tab capture.
  const actionsByTab = tallyActionsByTab(entries);
  const candidates: VideoCandidate[] = [];
  for (const { tab, video } of pageVideos) {
    if (!video) continue;
    try {
      const file = await video.path();
      candidates.push({ tab, file, bytes: (await stat(file)).size });
    } catch {
      // A page that never painted may have no video; the others still count.
    }
  }

  const selection = selectRecordedVideo(candidates, actionsByTab);
  if (!selection.ok) {
    state = null;
    if (selection.reason === "wrong-tab") {
      throw {
        code: "internal",
        message: `recording "${current.slug}" captured a tab with zero actions while ${selection.drivenActions} action(s) were driven on another tab — wrong tab captured`,
      };
    }
    throw {
      code: "internal",
      message: `no video was captured for "${current.slug}" — check that playwright's ffmpeg is installed`,
    };
  }
  const source = selection.source;

  await mkdir(outDir, { recursive: true });
  const videoPath = path.join(outDir, "raw.webm");
  await copyFile(source.file, videoPath);

  // 3. Distill it in-browser.
  await ensureHarnessBundle();
  const bundle = await readFile(HARNESS_BUNDLE);
  const video = await readFile(videoPath);
  const port = await daemonPort(session.profile);

  let finished = false;
  let failure: string | null = null;

  harnessRoutes["/harness"] = async () =>
    new Response(HARNESS_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  harnessRoutes["/harness.js"] = async () =>
    new Response(new Uint8Array(bundle), {
      headers: { "content-type": "text/javascript; charset=utf-8" },
    });
  harnessRoutes["/harness/video"] = async () =>
    new Response(new Uint8Array(video), { headers: { "content-type": "video/webm" } });
  harnessRoutes["/harness/meta"] = async () => json({ title: current.slug, segments });
  harnessRoutes["/harness/result"] = async (req) => {
    const body = parseResultBody(await req.json());
    if (!body) return json({ ok: false, error: "bad result body" }, 400);
    const target = safeJoin(outDir, body.path);
    if (!target) return json({ ok: false, error: `unsafe path: ${body.path}` }, 400);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(body.base64, "base64"));
    return json({ ok: true });
  };
  harnessRoutes["/harness/done"] = async () => {
    finished = true;
    return json({ ok: true });
  };
  harnessRoutes["/harness/error"] = async (req) => {
    failure = messageOf(await req.json());
    return json({ ok: true });
  };

  const relaunched = session.liveContext;
  if (!relaunched) throw { code: "internal", message: "browser is not running after relaunch" };
  const page = await relaunched.newPage();

  // The page reports progress into #log; carry it into any error, since the
  // daemon has no other view of what happened inside the browser.
  const harnessLog = async (): Promise<string> => {
    const text = await page.textContent("#log").catch(() => null);
    return text === null || text.trim() === "" ? "" : ` — harness log: ${tail(text, 8)}`;
  };

  const reportPath = path.join(outDir, "report.md");
  try {
    await page.goto(`http://127.0.0.1:${port}/harness`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    const deadline = Date.now() + DISTILL_TIMEOUT_MS;
    while (!finished && failure === null) {
      if (Date.now() > deadline) {
        throw { code: "internal", message: `distill timed out${await harnessLog()}` };
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (failure !== null) {
      throw { code: "internal", message: `distill failed: ${failure}${await harnessLog()}` };
    }
    if ((await mtimeMs(reportPath)) === null) {
      throw {
        code: "internal",
        message: `distill wrote no report.md into ${outDir}${await harnessLog()}`,
      };
    }
  } finally {
    await page.close().catch(() => undefined);
    for (const route of Object.keys(harnessRoutes)) delete harnessRoutes[route];
    state = null;
    // The webm has been copied into the package; the scratch dir would
    // otherwise accumulate a full recording per run.
    await rm(current.videoTmpDir, { recursive: true, force: true }).catch(() => undefined);
  }

  log(`recording "${current.slug}" distilled → ${outDir}`);
  return { dir: outDir, reportPath, videoPath, actionCount: segments.length };
}
