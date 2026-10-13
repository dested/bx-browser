// Recording (V1): one tab captured over CDP Page.startScreencast and piped
// into our own ffmpeg (see screencast.ts). No context relaunch, so start and
// stop answer in milliseconds and tabs, typed values and page ids survive.
// The package is video.webm (written once), transcript.txt (the action log
// plus marks, timed against the video) and recording.json; report.md comes
// from video-to-prompt's distill running inside the browser bx already
// controls (the library is browser-only by design).
//
// Runtime-neutral (node:* only): the daemon runs under Node, so the harness
// bundle is built by shelling out to `bun scripts/build-harness.ts`.

import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright-core";
import {
  BX_DIR_NAME,
  RUN_DIR,
  type ActionLogEntry,
  type Cmd,
  type RecordStartResult,
  type RecordStopResult,
} from "../protocol.ts";
import { OUTPUT_FPS, PageScreencast, Vp8Encoder, findPlaywrightFfmpeg, type Frame } from "./screencast.ts";
import type { Session } from "./session.ts";

type CmdOf<K extends Cmd["cmd"]> = Extract<Cmd, { cmd: K }>;
export type RecordStartOptions = Omit<CmdOf<"recordStart">, "cmd" | "slug">;
export type RecordStopOptions = Omit<CmdOf<"recordStop">, "cmd" | "outDir">;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const HARNESS_SRC = path.join(repoRoot, "src", "daemon", "harness", "harness.ts");
const HARNESS_BUNDLE = path.join(repoRoot, "dist", "harness.js");

const DEFAULT_SIZE = { width: 1280, height: 800 };
const FIRST_FRAME_MS = 1000;

interface Mark {
  /** ms from the video's first frame */
  atMs: number;
  text: string;
}

interface Recording {
  slug: string;
  tab: number;
  fps: 30 | 60;
  /** Date.now() at recordStart. */
  requestedAt: number;
  /** Date.now() when the first frame arrived: the video's zero. */
  zeroAt: number;
  actionLogStartIndex: number;
  capture: PageScreencast;
  encoder: Vp8Encoder;
  tmpDir: string;
  /** Screencast frames received, ms from zero. */
  frameTimes: number[];
  marks: Mark[];
  onClose: () => void;
}

/** One recording at a time — the daemon owns a single browser context. */
let state: Recording | null = null;
/** Set while recordStart is between its first await and `state`. */
let starting = false;

export function recordingSlug(): string | null {
  return state?.slug ?? null;
}

/** Keyed by full pathname (e.g. "/harness", "/harness/video"). */
export const harnessRoutes: Record<string, (req: Request) => Promise<Response>> = {};

// ---------------------------------------------------------------------------
// Transcript (pure — unit-tested in tests/record.test.ts)
// ---------------------------------------------------------------------------

/** mm:ss.mmm (minutes keep counting past 59). */
export function formatOffset(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const minutes = Math.floor(clamped / 60_000);
  const seconds = Math.floor((clamped % 60_000) / 1000);
  const millis = clamped % 1000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

export interface TranscriptLine {
  /** ms from the video's first frame (never negative) */
  t: number;
  text: string;
}

/**
 * Action-log entries (and marks, already in the log as recordMark) as offsets
 * into the video. `origin` is the wall time `entry.t` counts from; `zeroAt`
 * is the wall time of the video's first frame.
 */
export function transcriptLines(
  entries: readonly Pick<ActionLogEntry, "t" | "text" | "cmd">[],
  origin: number,
  zeroAt: number,
): TranscriptLine[] {
  return entries.map((entry) => ({
    t: Math.max(0, origin + entry.t - zeroAt),
    text: entry.cmd === "recordMark" ? `— mark: ${entry.text}` : entry.text,
  }));
}

export function transcriptText(slug: string, lines: readonly TranscriptLine[]): string {
  const head = `# ${slug} — action log (bx commands, timed against video.webm)\n`;
  if (lines.length === 0) return `${head}(no actions)\n`;
  return head + lines.map((line) => `[${formatOffset(line.t)}] ${line.text}`).join("\n") + "\n";
}

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
// ffmpeg — playwright-core with channel:chrome does not ship it.
// ---------------------------------------------------------------------------

let ffmpegPath: string | null = null;

async function ensureFfmpeg(): Promise<string> {
  if (ffmpegPath !== null) return ffmpegPath;
  const found = await findPlaywrightFfmpeg();
  if (found !== null) return (ffmpegPath = found);
  log("playwright ffmpeg missing — installing (needed for video capture)");
  const result = await runCommand("bun", ["x", "playwright-core", "install", "ffmpeg"], repoRoot);
  const installed = result.code === 0 ? await findPlaywrightFfmpeg() : null;
  if (installed === null) {
    throw {
      code: "internal",
      message: "recording needs playwright's ffmpeg — run: bun x playwright-core install ffmpeg",
    };
  }
  log("ffmpeg installed");
  return (ffmpegPath = installed);
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

/**
 * The harness page. The routes have no token, so each distill gets a nonce
 * (O5) that every /harness* request must carry as `?n=`. The bundle's own
 * fetches take it from a fetch wrapper installed before the bundle loads.
 */
export function harnessHtml(nonce: string): string {
  const n = JSON.stringify(nonce);
  return (
    '<!doctype html><meta charset="utf-8"><title>bx distill</title><pre id="log"></pre>' +
    `<script>(() => { const n = ${n}; const f = window.fetch.bind(window);` +
    ' window.fetch = (input, init) => f(typeof input === "string" && input.startsWith("/harness")' +
    ' ? input + (input.includes("?") ? "&" : "?") + "n=" + encodeURIComponent(n) : input, init); })();</script>' +
    `<script type="module" src="/harness.js?n=${encodeURIComponent(nonce)}"></script>`
  );
}

/** Wraps a harness route so a request without this distill's nonce gets a 404. */
export function requireNonce(
  nonce: string,
  handler: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req) => {
    if (new URL(req.url).searchParams.get("n") !== nonce) return new Response("not found", { status: 404 });
    return handler(req);
  };
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

/** The page for `tab`, or the active page; launches the browser if needed. */
async function recordedPage(session: Session, tab: number | undefined): Promise<{ page: Page; tab: number }> {
  const { pages } = await session.tabs();
  const want = tab ?? pages.find((p) => p.active)?.id;
  if (want === undefined) throw { code: "no_page", message: "no page to record" };
  const page = session.liveContext?.pages().find((p) => session.tabIdOf(p) === want);
  if (!page) throw { code: "no_page", message: `tab ${want} is closed` };
  return { page, tab: want };
}

function waitFor<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

export async function recordStart(
  session: Session,
  slug: string,
  opts: RecordStartOptions = {},
): Promise<RecordStartResult> {
  if (state || starting) throw { code: "already_recording", message: `already recording "${state?.slug ?? slug}"` };
  starting = true;
  try {
    return await beginRecording(session, slug, opts);
  } finally {
    starting = false;
  }
}

async function beginRecording(session: Session, slug: string, opts: RecordStartOptions): Promise<RecordStartResult> {
  const ffmpeg = await ensureFfmpeg();
  const { page, tab } = await recordedPage(session, opts.tab);
  const context = session.liveContext;
  if (!context) throw { code: "internal", message: "browser is not running" };

  const requestedAt = Date.now();
  const size = page.viewportSize() ?? DEFAULT_SIZE;
  const tmpDir = path.join(os.homedir(), BX_DIR_NAME, "tmp-video", `${slug}-${requestedAt.toString(36)}`);
  await mkdir(tmpDir, { recursive: true });
  const encoder = new Vp8Encoder(ffmpeg, path.join(tmpDir, "video.webm"), size, { live: true });

  const frameTimes: number[] = [];
  let first: Frame | null = null;
  let resolveFirst: (frame: Frame) => void = () => undefined;
  const firstFrame = new Promise<Frame>((resolve) => {
    resolveFirst = resolve;
  });
  const onFrame = (frame: Frame): void => {
    encoder.push(frame.data, frame.at);
    if (first === null) {
      first = frame;
      resolveFirst(frame);
    }
    frameTimes.push(frame.at - first.at);
  };

  let capture: PageScreencast | null = null;
  try {
    capture = await PageScreencast.start(context, page, { size }, onFrame);
    // A still page sends no screencast frame until something repaints, so a
    // screenshot of what the tab shows right now races the first frame.
    void capture.snapshot(size).then(
      (frame) => {
        if (first === null) onFrame(frame);
      },
      () => undefined,
    );
    const got = await waitFor(firstFrame, FIRST_FRAME_MS);
    if (got === null) {
      throw {
        code: "internal",
        message: `no frame within ${FIRST_FRAME_MS} ms from tab ${tab} — is its window minimized or covered?`,
      };
    }
    const actionLogStartIndex = session.actions.nextIndex;
    // The capped log must not trim this recording's transcript away mid-take.
    session.actions.holdFrom(actionLogStartIndex);
    const recording: Recording = {
      slug,
      tab,
      fps: opts.fps ?? 30,
      requestedAt,
      zeroAt: got.at,
      actionLogStartIndex,
      capture,
      encoder,
      tmpDir,
      frameTimes,
      marks: [],
      onClose: () => {
        if (state !== recording) return;
        recording.marks.push({ atMs: Date.now() - recording.zeroAt, text: "tab closed" });
        void recording.capture.stop();
        log(`recording "${slug}": tab ${tab} closed — capture ended`);
      },
    };
    page.once("close", recording.onClose);
    state = recording;
    log(`recording "${slug}" tab ${tab} → ${tmpDir}`);
    return { slug, tab, firstFrameMs: got.at - requestedAt };
  } catch (err) {
    if (capture) await capture.stop();
    encoder.kill();
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

export async function recordStop(
  session: Session,
  outDir: string,
  opts: RecordStopOptions = {},
): Promise<RecordStopResult> {
  const current = state;
  if (!current) throw { code: "not_recording", message: "not recording" };
  state = null;
  try {
    return await finishRecording(session, current, outDir, opts);
  } finally {
    current.capture.page.off("close", current.onClose);
    session.actions.holdFrom(null);
    for (const route of Object.keys(harnessRoutes)) delete harnessRoutes[route];
    // The webm was moved into the package (or the stop failed); either way
    // the scratch dir would otherwise accumulate a full recording per run.
    await rm(current.tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** rename, or copy + delete across volumes (~/.bx is on the system drive). */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch {
    await copyFile(from, to);
    await rm(from, { force: true });
  }
}

async function finishRecording(
  session: Session,
  current: Recording,
  outDir: string,
  _opts: RecordStopOptions,
): Promise<RecordStopResult> {
  const stopAt = Date.now();
  await current.capture.stop();
  // The last frame holds until the moment stop was asked for.
  await current.encoder.close(stopAt);

  const entries = session.actions.since(current.actionLogStartIndex);
  const lines = transcriptLines(entries, session.logTimeOrigin, current.zeroAt);
  const durationMs = stopAt - current.zeroAt;

  await mkdir(outDir, { recursive: true });
  const videoPath = path.join(outDir, "video.webm");
  const transcriptPath = path.join(outDir, "transcript.txt");
  const metaPath = path.join(outDir, "recording.json");
  await moveFile(current.encoder.file, videoPath);
  await writeFile(transcriptPath, transcriptText(current.slug, lines));
  await writeFile(
    metaPath,
    `${JSON.stringify(
      {
        slug: current.slug,
        tab: current.tab,
        startedAt: new Date(current.zeroAt).toISOString(),
        durationMs,
        captureFps: current.fps,
        outputFps: OUTPUT_FPS,
        frames: current.frameTimes.length,
        screencastFrames: current.capture.frames,
        encodedFrames: current.encoder.written,
        marks: current.marks,
        actions: lines,
        frameTimesMs: current.frameTimes,
      },
      null,
      2,
    )}\n`,
  );

  log(`recording "${current.slug}" stopped in ${Date.now() - stopAt} ms → ${outDir}`);
  return {
    dir: outDir,
    videoPath,
    transcriptPath,
    metaPath,
    reportPath: path.join(outDir, "report.md"),
    distill: "failed",
    durationMs,
    frames: current.frameTimes.length,
    actionCount: lines.length,
  };
}
