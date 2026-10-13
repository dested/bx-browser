// Recording (V1): one tab captured over CDP Page.startScreencast and piped
// into our own ffmpeg (see screencast.ts). No context relaunch, so start and
// stop answer in milliseconds and tabs, typed values and page ids survive.
// The package is video.webm (written once), transcript.txt (the action log
// plus marks, timed against the video), recording.json, an optional
// video.mp4, and report.md from video-to-prompt's distill. Distill runs inside
// the browser bx already controls (the library is browser-only by design),
// in the background after stop unless the caller waits for it.
//
// Two capture modes: live (every frame goes straight to ffmpeg) and ring
// (frames stay in memory, the newest N seconds, and are encoded on save/stop).
//
// Runtime-neutral (node:* only): the daemon runs under Node, so the harness
// bundle is built by running `bun scripts/build-harness.ts`. Every helper
// process is spawned without a shell and without a console window.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Page } from "playwright-core";
import {
  BX_DIR_NAME,
  RUN_DIR,
  type ActionLogEntry,
  type Cmd,
  type RecordStartResult,
  type RecordStatusResult,
  type RecordStopResult,
} from "../protocol.ts";
import {
  FrameRing,
  OUTPUT_FPS,
  PageScreencast,
  Vp8Encoder,
  encodeClip,
  findOnPath,
  findPlaywrightFfmpeg,
  runProcess,
  systemX264Ffmpeg,
  transcodeMp4,
  type Frame,
} from "./screencast.ts";
import type { Session } from "./session.ts";

type CmdOf<K extends Cmd["cmd"]> = Extract<Cmd, { cmd: K }>;
export type RecordStartOptions = Omit<CmdOf<"recordStart">, "cmd" | "slug">;
export type RecordStopOptions = Omit<CmdOf<"recordStop">, "cmd" | "outDir">;
export type RecordSaveOptions = Omit<CmdOf<"recordSave">, "cmd">;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const HARNESS_SRC = path.join(repoRoot, "src", "daemon", "harness", "harness.ts");
const HARNESS_WORDING = path.join(repoRoot, "src", "daemon", "harness", "wording.ts");
const HARNESS_BUNDLE = path.join(repoRoot, "dist", "harness.js");

const DEFAULT_SIZE = { width: 1280, height: 800 };
const FIRST_FRAME_MS = 1000;
const DISTILL_TIMEOUT_MS = 180_000;
/** Ring mode moves the action-log hold up to the ring's oldest frame this often. */
const RING_UPKEEP_MS = 5000;

/** Wall-clock (Date.now()) moments; the package rebases them onto its video. */
interface Mark {
  at: number;
  text: string;
}
interface TabSpan {
  tab: number;
  at: number;
}

/** Where frames go: straight to ffmpeg (live) or into memory (ring). */
interface Sink {
  encoder: Vp8Encoder | null;
  ring: FrameRing | null;
  frames: number;
  /** Live mode: frame arrival times (Date.now()). Ring mode reads the ring. */
  frameAts: number[];
}

interface Recording {
  slug: string;
  follow: boolean;
  fps: 30 | 60;
  ring: number | null;
  ffmpeg: string;
  size: { width: number; height: number };
  /** Date.now() when the first frame arrived: the live video's zero. */
  zeroAt: number;
  tab: number;
  tabs: TabSpan[];
  capture: PageScreencast;
  /** Every capture (the first and each follow re-target) feeds frames here. */
  onFrame: (frame: Frame) => void;
  sink: Sink;
  tmpDir: string;
  marks: Mark[];
  /** The action log is held from here (moves up in ring mode). */
  holdIndex: number;
  /** Re-targets run one at a time; stop waits for the last one. */
  chain: Promise<void>;
  cleanups: (() => void)[];
}

/** One recording at a time — the daemon owns a single browser context. */
let state: Recording | null = null;
/** Set while recordStart is between its first await and `state`. */
let starting = false;

export function recordingSlug(): string | null {
  return state?.slug ?? null;
}

/** A recording or a distill is in progress: the daemon must not idle out. */
export function recordBusy(): boolean {
  return state !== null || starting || distills.size > 0;
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
// Helpers
// ---------------------------------------------------------------------------

function tail(text: string, lines = 5): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err && typeof err.message === "string") {
    return err.message;
  }
  return String(err);
}

/** bun's own executable (spawned directly: no shell, so no PATHEXT). */
function bunExe(): string {
  const found = findOnPath("bun");
  if (found !== null) return found;
  const home = process.env.BUN_INSTALL ?? path.join(os.homedir(), ".bun");
  const local = path.join(home, "bin", process.platform === "win32" ? "bun.exe" : "bun");
  if (existsSync(local)) return local;
  throw { code: "internal", message: "bun is not on PATH (recording needs it to install ffmpeg and build the distill page)" };
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

function waitFor<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
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
  const result = await runProcess(bunExe(), ["x", "playwright-core", "install", "ffmpeg"], repoRoot);
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

/** --mp4 needs a system ffmpeg with libx264; checked before anything is torn down. */
async function requireX264(): Promise<string> {
  const exe = await systemX264Ffmpeg();
  if (exe === null) {
    throw { code: "bad_request", message: "--mp4 needs ffmpeg with libx264 on PATH (the webm is always written)" };
  }
  return exe;
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
  const sources = [await mtimeMs(HARNESS_SRC), await mtimeMs(HARNESS_WORDING)];
  if (bundle !== null && sources.every((s) => s !== null && bundle >= s)) return;

  log("building harness bundle");
  const result = await runProcess(bunExe(), ["scripts/build-harness.ts"], repoRoot);
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
// Distill: serialized (the harness routes are global), in the background
// ---------------------------------------------------------------------------

type DistillOutcome = "done" | "failed";

/** Package dirs with a distill queued or running. */
const distills = new Map<string, Promise<DistillOutcome>>();
let distillChain: Promise<unknown> = Promise.resolve();

function queueDistill(session: Session, dir: string, title: string, lines: TranscriptLine[]): Promise<DistillOutcome> {
  const job = distillChain.then(async (): Promise<DistillOutcome> => {
    const started = Date.now();
    try {
      await runDistill(session, dir, title, lines);
      log(`distilled ${dir} in ${Date.now() - started} ms`);
      return "done";
    } catch (err) {
      const message = errorText(err);
      log(`distill failed for ${dir}: ${message}`);
      await writeFile(path.join(dir, "distill.log"), `${message}\n`).catch(() => undefined);
      return "failed";
    }
  });
  distillChain = job;
  distills.set(dir, job);
  void job.then(() => {
    if (distills.get(dir) === job) distills.delete(dir);
  });
  return job;
}

async function runDistill(session: Session, dir: string, title: string, segments: TranscriptLine[]): Promise<void> {
  // report.md means "distill finished"; a stale one must not answer for this run.
  await rm(path.join(dir, "report.md"), { force: true });
  await rm(path.join(dir, "distill.log"), { force: true });
  await ensureHarnessBundle();
  const bundle = await readFile(HARNESS_BUNDLE);
  const video = await readFile(path.join(dir, "video.webm"));
  const port = await daemonPort(session.profile);

  let finished = false;
  let failure: string | null = null;
  const nonce = randomUUID();
  const route = (pathname: string, handler: (req: Request) => Promise<Response>): void => {
    harnessRoutes[pathname] = requireNonce(nonce, handler);
  };

  route("/harness", async () =>
    new Response(harnessHtml(nonce), { headers: { "content-type": "text/html; charset=utf-8" } }));
  route("/harness.js", async () =>
    new Response(new Uint8Array(bundle), {
      headers: { "content-type": "text/javascript; charset=utf-8" },
    }));
  route("/harness/video", async () =>
    new Response(new Uint8Array(video), { headers: { "content-type": "video/webm" } }));
  route("/harness/meta", async () => json({ title, segments }));
  route("/harness/result", async (req) => {
    const body = parseResultBody(await req.json());
    if (!body) return json({ ok: false, error: "bad result body" }, 400);
    const target = safeJoin(dir, body.path);
    if (!target) return json({ ok: false, error: `unsafe path: ${body.path}` }, 400);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(body.base64, "base64"));
    return json({ ok: true });
  });
  route("/harness/done", async () => {
    finished = true;
    return json({ ok: true });
  });
  route("/harness/error", async (req) => {
    failure = messageOf(await req.json());
    return json({ ok: true });
  });

  let page: Page | null = null;
  try {
    // bx's own page: never in tabs, indexes or the active slot (K7).
    const opened = await session.openInternalPage();
    page = opened;

    // The page reports progress into #log; carry it into any error, since the
    // daemon has no other view of what happened inside the browser.
    const harnessLog = async (): Promise<string> => {
      const text = await opened.textContent("#log").catch(() => null);
      return text === null || text.trim() === "" ? "" : ` — harness log: ${tail(text, 8)}`;
    };

    await opened.goto(`http://127.0.0.1:${port}/harness?n=${encodeURIComponent(nonce)}`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    const deadline = Date.now() + DISTILL_TIMEOUT_MS;
    while (!finished && failure === null) {
      if (Date.now() > deadline) throw { code: "internal", message: `distill timed out${await harnessLog()}` };
      if (opened.isClosed()) throw { code: "internal", message: "the distill page was closed" };
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (failure !== null) throw { code: "internal", message: `distill failed: ${failure}${await harnessLog()}` };
    if ((await mtimeMs(path.join(dir, "report.md"))) === null) {
      throw { code: "internal", message: `distill wrote no report.md into ${dir}${await harnessLog()}` };
    }
  } finally {
    await page?.close().catch(() => undefined);
    for (const key of Object.keys(harnessRoutes)) delete harnessRoutes[key];
  }
}

// ---------------------------------------------------------------------------
// Capture
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

function feed(sink: Sink, frame: Frame): void {
  sink.frames++;
  if (sink.encoder) {
    sink.encoder.push(frame.data, frame.at);
    sink.frameAts.push(frame.at);
  }
  sink.ring?.push(frame);
}

/**
 * Starts the screencast on `page`. A still page sends no screencast frame
 * until something repaints, so a screenshot of what it shows right now races
 * the first frame; whichever lands first opens this stretch of video.
 *
 * `handoff` (follow): the capture being replaced keeps running until this one
 * has started, then stops before this one's frames flow, so a failed start
 * leaves the old capture in place and the two never interleave.
 */
async function capturePage(
  session: Session,
  page: Page,
  size: { width: number; height: number },
  onFrame: (frame: Frame) => void,
  handoff?: PageScreencast,
): Promise<PageScreencast> {
  const context = session.liveContext;
  if (!context) throw { code: "internal", message: "browser is not running" };
  let open = handoff === undefined;
  let forwarded = 0;
  const gated = (frame: Frame): void => {
    if (!open) return;
    forwarded++;
    onFrame(frame);
  };
  const capture = await startScreencast(context, page, size, gated);
  if (handoff) {
    await handoff.stop();
    open = true;
  }
  void capture.snapshot(size).then(
    (frame) => {
      if (forwarded === 0 && !capture.stopped) onFrame(frame);
    },
    () => undefined,
  );
  return capture;
}

/** Back-off for a tab Chrome hasn't attached yet ("Not attached to an active page"). */
const ATTACH_RETRY_MS = [25, 50, 100, 200, 400, 800];

/**
 * A tab opened a moment ago (a flow's first step, `tab new`) can't screencast
 * until Chrome attaches its first document; retry for about 1.5 s.
 */
async function startScreencast(
  context: BrowserContext,
  page: Page,
  size: { width: number; height: number },
  onFrame: (frame: Frame) => void,
): Promise<PageScreencast> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await PageScreencast.start(context, page, { size }, onFrame);
    } catch (err) {
      const wait = ATTACH_RETRY_MS[attempt];
      if (wait === undefined || page.isClosed() || !/not attached to an active page/i.test(errorText(err))) throw err;
      await delay(wait);
    }
  }
}

export async function recordStart(
  session: Session,
  slug: string,
  opts: RecordStartOptions = {},
): Promise<RecordStartResult> {
  if (state || starting) throw { code: "already_recording", message: `already recording "${state?.slug ?? slug}"` };
  if (opts.follow === true && opts.tab !== undefined) {
    throw { code: "bad_request", message: "pass --tab or --follow, not both" };
  }
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

  const requestedAt = Date.now();
  const fps = opts.fps ?? 30;
  const ring = opts.ring ?? null;
  const size = page.viewportSize() ?? DEFAULT_SIZE;
  const tmpDir = path.join(os.homedir(), BX_DIR_NAME, "tmp-video", `${slug}-${requestedAt.toString(36)}`);
  await mkdir(tmpDir, { recursive: true });
  const sink: Sink = {
    encoder: ring === null ? new Vp8Encoder(ffmpeg, path.join(tmpDir, "video.webm"), size, { live: true }) : null,
    ring: ring === null ? null : new FrameRing(ring, fps),
    frames: 0,
    frameAts: [],
  };

  let resolveFirst: (frame: Frame) => void = () => undefined;
  const firstFrame = new Promise<Frame>((resolve) => {
    resolveFirst = resolve;
  });
  const onFrame = (frame: Frame): void => {
    feed(sink, frame);
    if (sink.frames === 1) resolveFirst(frame);
  };

  let capture: PageScreencast | null = null;
  try {
    capture = await capturePage(session, page, size, onFrame);
    const got = await waitFor(firstFrame, FIRST_FRAME_MS);
    if (got === null) {
      throw {
        code: "internal",
        message: `no frame within ${FIRST_FRAME_MS} ms from tab ${tab} — is its window minimized or covered?`,
      };
    }
    const holdIndex = session.actions.nextIndex;
    // The capped log must not trim this recording's transcript away mid-take.
    session.actions.holdFrom(holdIndex);
    const recording: Recording = {
      slug,
      follow: opts.follow === true,
      fps,
      ring,
      ffmpeg,
      size,
      zeroAt: got.at,
      tab,
      tabs: [{ tab, at: got.at }],
      capture,
      onFrame,
      sink,
      tmpDir,
      marks: [],
      holdIndex,
      chain: Promise.resolve(),
      cleanups: [],
    };
    watchClose(recording, page);
    if (recording.follow) {
      // The hook fires inside session bookkeeping; act once it has settled.
      const off = session.onActiveChange(() => queueMicrotask(() => followActive(session, recording)));
      recording.cleanups.push(off);
    }
    if (ring !== null) {
      const timer = setInterval(() => ringUpkeep(session, recording), RING_UPKEEP_MS);
      timer.unref();
      recording.cleanups.push(() => clearInterval(timer));
    }
    state = recording;
    log(`recording "${slug}" tab ${tab}${ring === null ? "" : ` (ring ${ring}s)`} → ${tmpDir}`);
    return {
      slug,
      tab,
      ...(ring === null ? {} : { ring }),
      firstFrameMs: got.at - requestedAt,
    };
  } catch (err) {
    if (capture) await capture.stop();
    sink.encoder?.kill();
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * --follow: move the capture to the active tab. Re-targets queue on the
 * recording's chain so two quick tab switches can't interleave, and stop
 * waits for the last one. The old capture runs until the new one has started
 * (capturePage's handoff); a still page opens on a screenshot.
 */
function followActive(session: Session, rec: Recording): void {
  rec.chain = rec.chain
    .then(async () => {
      if (state !== rec) return;
      // activeTabId re-picks a fallback when the active tab just closed.
      const id = session.activeTabId;
      if (id === undefined || (id === rec.tab && !rec.capture.stopped)) return;
      const page = session.liveContext?.pages().find((p) => session.tabIdOf(p) === id);
      if (!page || page.isClosed()) return;
      rec.capture = await capturePage(session, page, rec.size, rec.onFrame, rec.capture);
      rec.tab = id;
      rec.tabs.push({ tab: id, at: Date.now() });
      watchClose(rec, page);
      log(`recording "${rec.slug}" follows tab ${id}`);
    })
    .catch((err: unknown) => log(`recording "${rec.slug}": follow failed: ${errorText(err)}`));
}

/** A recorded tab that closes ends its stream with a mark; the video holds its last frame. */
function watchClose(rec: Recording, page: Page): void {
  const onClose = (): void => {
    if (state !== rec || rec.capture.page !== page) return;
    rec.marks.push({ at: Date.now(), text: `tab ${rec.tab} closed` });
    void rec.capture.stop();
    log(`recording "${rec.slug}": tab ${rec.tab} closed — capture ended`);
  };
  page.once("close", onClose);
  rec.cleanups.push(() => page.off("close", onClose));
}

/** Ring mode: drop frames that left the window and let the action log trim behind them. */
function ringUpkeep(session: Session, rec: Recording): void {
  const ring = rec.sink.ring;
  if (!ring || state !== rec) return;
  ring.trim(Date.now());
  const oldest = ring.oldestAt;
  if (oldest === null) return;
  const cutoff = oldest - session.logTimeOrigin;
  const keep = session.actions.since(rec.holdIndex).find((entry) => entry.t >= cutoff);
  rec.holdIndex = keep?.index ?? session.actions.nextIndex;
  session.actions.holdFrom(rec.holdIndex);
}

// ---------------------------------------------------------------------------
// Packaging
// ---------------------------------------------------------------------------

interface PackageInput {
  rec: Recording;
  outDir: string;
  /** The webm, already encoded; moved into the package. */
  video: string;
  zeroAt: number;
  endAt: number;
  frameAts: number[];
  encodedFrames: number;
  /** Wall time before which actions belong to another clip (ring saves); null keeps all. */
  since: number | null;
  mp4: string | null;
  distill: boolean;
}

async function writePackage(session: Session, input: PackageInput): Promise<RecordStopResult> {
  const { rec, outDir, zeroAt, endAt } = input;
  const origin = session.logTimeOrigin;
  const entries = session.actions
    .since(rec.holdIndex)
    .filter((entry) => origin + entry.t <= endAt && (input.since === null || origin + entry.t >= input.since));
  const lines = transcriptLines(entries, origin, zeroAt);
  const rebase = (at: number): number => Math.max(0, at - zeroAt);
  const inClip = (at: number): boolean => at <= endAt && (input.since === null || at >= input.since);

  await mkdir(outDir, { recursive: true });
  const videoPath = path.join(outDir, "video.webm");
  const transcriptPath = path.join(outDir, "transcript.txt");
  const metaPath = path.join(outDir, "recording.json");
  await moveFile(input.video, videoPath);
  await writeFile(transcriptPath, transcriptText(rec.slug, lines));
  const durationMs = endAt - zeroAt;
  await writeFile(
    metaPath,
    `${JSON.stringify(
      {
        slug: rec.slug,
        startedAt: new Date(zeroAt).toISOString(),
        durationMs,
        captureFps: rec.fps,
        outputFps: OUTPUT_FPS,
        ...(rec.ring === null ? {} : { ring: rec.ring }),
        // The span on screen when the clip opens, and every later one.
        tabs: rec.tabs
          .filter((span, i) => span.at <= endAt && (input.since === null || (rec.tabs[i + 1]?.at ?? Infinity) > input.since))
          .map((span) => ({ tab: span.tab, atMs: rebase(span.at) })),
        frames: input.frameAts.length,
        encodedFrames: input.encodedFrames,
        marks: rec.marks.filter((mark) => inClip(mark.at)).map((mark) => ({ atMs: rebase(mark.at), text: mark.text })),
        actions: lines,
        frameTimesMs: input.frameAts.map(rebase),
      },
      null,
      2,
    )}\n`,
  );

  let mp4Path: string | undefined;
  if (input.mp4 !== null) {
    mp4Path = path.join(outDir, "video.mp4");
    await transcodeMp4(input.mp4, videoPath, mp4Path);
  }

  const job = queueDistill(session, outDir, rec.slug, lines);
  const distill = input.distill ? await job : "running";
  return {
    dir: outDir,
    videoPath,
    ...(mp4Path === undefined ? {} : { mp4Path }),
    transcriptPath,
    metaPath,
    reportPath: path.join(outDir, "report.md"),
    distill,
    durationMs,
    frames: input.frameAts.length,
    actionCount: lines.length,
  };
}

export async function recordStop(
  session: Session,
  outDir: string,
  opts: RecordStopOptions = {},
): Promise<RecordStopResult> {
  const current = state;
  if (!current) throw { code: "not_recording", message: "not recording" };
  // Before anything is torn down: a refused --mp4 leaves the recording running.
  const mp4 = opts.mp4 === true ? await requireX264() : null;
  if (state !== current) throw { code: "not_recording", message: "not recording" };
  state = null;
  const stopAt = Date.now();
  try {
    await current.chain;
    await current.capture.stop();
    const { encoder, ring } = current.sink;
    if (encoder) {
      // The last frame holds until the moment stop was asked for.
      await encoder.close(stopAt);
      return await writePackage(session, {
        rec: current,
        outDir,
        video: encoder.file,
        zeroAt: current.zeroAt,
        endAt: stopAt,
        frameAts: current.sink.frameAts,
        encodedFrames: encoder.written,
        since: null,
        mp4,
        distill: opts.distill === true,
      });
    }
    if (!ring) throw { code: "internal", message: "recording has neither an encoder nor a ring" };
    return await packageRing(session, current, { from: -Infinity, endAt: stopAt, outDir, mp4, distill: opts.distill === true });
  } finally {
    for (const cleanup of current.cleanups) cleanup();
    session.actions.holdFrom(null);
    // The webm was moved into the package (or the stop failed); either way
    // the scratch dir would otherwise accumulate a full recording per run.
    await rm(current.tmpDir, { recursive: true, force: true }).catch(() => undefined);
    log(`recording "${current.slug}" stopped → ${outDir}`);
  }
}

async function packageRing(
  session: Session,
  rec: Recording,
  opts: { from: number; endAt: number; outDir: string; mp4: string | null; distill: boolean },
): Promise<RecordStopResult> {
  const ring = rec.sink.ring;
  if (!ring) throw { code: "not_recording", message: "this recording has no ring (bx record start --ring <secs>)" };
  const clip = ring.clip(opts.from);
  const head = clip[0];
  if (!head) throw { code: "internal", message: "the ring holds no frames" };
  const file = path.join(rec.tmpDir, `clip-${Date.now().toString(36)}.webm`);
  const encodedFrames = await encodeClip(rec.ffmpeg, file, rec.size, clip, opts.endAt);
  return writePackage(session, {
    rec,
    outDir: opts.outDir,
    video: file,
    zeroAt: head.at,
    endAt: opts.endAt,
    frameAts: clip.map((frame) => frame.at),
    encodedFrames,
    since: head.at,
    mp4: opts.mp4,
    distill: opts.distill,
  });
}

/** Ring mode: package the newest `lastSecs` while capture carries on. */
export async function recordSave(session: Session, opts: RecordSaveOptions): Promise<RecordStopResult> {
  const current = state;
  if (!current?.sink.ring) {
    throw { code: "not_recording", message: "record save needs a ring recording (bx record start --ring <secs>)" };
  }
  const mp4 = opts.mp4 === true ? await requireX264() : null;
  const now = Date.now();
  return packageRing(session, current, {
    from: now - opts.lastSecs * 1000,
    endAt: now,
    outDir: opts.outDir,
    mp4,
    distill: false,
  });
}

/** A chapter marker: an action-log entry, so it lands in the transcript and the report. */
export function recordMark(session: Session, text: string): RecordStatusResult {
  const current = state;
  if (!current) throw { code: "not_recording", message: "not recording" };
  const at = Date.now();
  current.marks.push({ at, text });
  session.actions.push({
    t: at - session.logTimeOrigin,
    cmd: "recordMark",
    text,
    cmdJson: JSON.stringify({ cmd: "recordMark", text }),
    tab: current.tab,
  });
  return recordStatus();
}

export function recordStatus(): RecordStatusResult {
  const distilling = [...distills.keys()];
  const current = state;
  if (!current) return { recording: false, distilling };
  return {
    recording: true,
    slug: current.slug,
    tab: current.tab,
    follow: current.follow,
    ...(current.ring === null ? {} : { ring: current.ring, bufferedBytes: current.sink.ring?.bytes ?? 0 }),
    elapsedMs: Date.now() - current.zeroAt,
    frames: current.sink.frames,
    marks: current.marks.length,
    distilling,
  };
}

// ---------------------------------------------------------------------------
// Re-distill an existing package
// ---------------------------------------------------------------------------

interface PackageMeta {
  slug: string;
  durationMs: number;
  frames: number;
  lines: TranscriptLine[];
}

/** recording.json, narrowed without trusting it. */
export function parsePackageMeta(value: unknown): PackageMeta | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("slug" in value) || !("durationMs" in value) || !("actions" in value)) return null;
  const { slug, durationMs, actions } = value;
  if (typeof slug !== "string" || typeof durationMs !== "number" || !Array.isArray(actions)) return null;
  const lines: TranscriptLine[] = [];
  for (const entry of actions) {
    if (typeof entry !== "object" || entry === null || !("t" in entry) || !("text" in entry)) continue;
    const { t, text } = entry;
    if (typeof t === "number" && typeof text === "string") lines.push({ t, text });
  }
  const frames = "frames" in value && typeof value.frames === "number" ? value.frames : 0;
  return { slug, durationMs, frames, lines };
}

export async function recordDistill(session: Session, dir: string): Promise<RecordStopResult> {
  const metaPath = path.join(dir, "recording.json");
  const videoPath = path.join(dir, "video.webm");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(metaPath, "utf8"));
  } catch {
    throw { code: "bad_request", message: `no recording package at ${dir} (recording.json missing or unreadable)` };
  }
  const meta = parsePackageMeta(raw);
  if (!meta) throw { code: "bad_request", message: `${metaPath} is not a bx recording.json` };
  if (!existsSync(videoPath)) throw { code: "bad_request", message: `${videoPath} is missing` };
  const distill = await queueDistill(session, dir, meta.slug, meta.lines);
  const mp4Path = path.join(dir, "video.mp4");
  return {
    dir,
    videoPath,
    ...(existsSync(mp4Path) ? { mp4Path } : {}),
    transcriptPath: path.join(dir, "transcript.txt"),
    metaPath,
    reportPath: path.join(dir, "report.md"),
    distill,
    durationMs: meta.durationMs,
    frames: meta.frames,
    actionCount: meta.lines.length,
  };
}
