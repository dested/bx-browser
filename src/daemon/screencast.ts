// Recording capture core: CDP Page.startScreencast on one page, JPEG frames
// piped into our own ffmpeg (Playwright's bundled build, VP8 webm). Nothing
// here relaunches or reconfigures the browser context, so tabs, typed values
// and page ids survive a recording. Playwright's recordVideo and
// page.screencast must never run on a page this captures.
//
// Node runtime (like the rest of src/daemon): node:* only, no Bun.*.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserContext, CDPSession, Page } from "playwright-core";

/** The webm is constant frame rate; Chrome sends frames only on damage. */
export const OUTPUT_FPS = 25;

export interface Frame {
  data: Buffer;
  /**
   * Date.now() when the frame reached the daemon. Pacing and the transcript
   * both run on this clock; Chrome's own frame timestamp is not assumed to match it.
   */
  at: number;
}

// ---------------------------------------------------------------------------
// Pacing (pure — unit-tested in tests/screencast.test.ts)
// ---------------------------------------------------------------------------

/**
 * Turns damage-driven frames into a constant-rate stream. Each frame holds
 * its slot until the next one arrives; `advance` answers how many copies of
 * the frame held so far to write before the new one takes over. Frames that
 * land in the same slot replace each other (the last one wins).
 */
export class FramePacer {
  private first: number | null = null;
  private emitted = 0;
  private readonly fps: number;

  constructor(fps = OUTPUT_FPS) {
    this.fps = fps;
  }

  /** Copies of the held frame to write now that a frame at `ts` (seconds) arrived. */
  advance(ts: number): number {
    if (this.first === null) {
      this.first = ts;
      return 0;
    }
    return this.fill(ts);
  }

  /**
   * Copies of the held frame that cover every slot before `ts`, with the frame
   * still held. A live encoder tops up on a timer so a still page doesn't
   * leave seconds of duplicates to encode at stop.
   */
  fill(ts: number): number {
    if (this.first === null) return 0;
    // The epsilon keeps float error (10.04 - 10) * 25 = 0.99999 out of the slot math.
    const slot = Math.floor((ts - this.first) * this.fps + 1e-6);
    const n = Math.max(0, slot - this.emitted);
    this.emitted += n;
    return n;
  }

  /** Copies of the held frame that carry the video to `endTs`; at least one. */
  finish(endTs: number): number {
    if (this.first === null) return 0;
    const end = Math.ceil((endTs - this.first) * this.fps - 1e-6);
    const n = Math.max(1, end - this.emitted);
    this.emitted += n;
    return n;
  }

  /** Frames written so far. */
  get written(): number {
    return this.emitted;
  }
}

// ---------------------------------------------------------------------------
// Ring (pure — unit-tested in tests/screencast.test.ts)
// ---------------------------------------------------------------------------

export const RING_MAX_BYTES = 64 * 1024 * 1024;

/**
 * The newest `seconds` of frames in memory, encoded only on save or stop.
 * One frame per 1/fps slot (the last one in a slot wins). The frame just
 * before the window is kept: it is what the screen showed when the window
 * opens. Over `maxBytes`, the oldest frames go first.
 */
export class FrameRing {
  private frames: Frame[] = [];
  private held = 0;
  private readonly windowMs: number;
  private readonly fps: number;
  private readonly maxBytes: number;

  constructor(seconds: number, fps: number, maxBytes = RING_MAX_BYTES) {
    this.windowMs = seconds * 1000;
    this.fps = fps;
    this.maxBytes = maxBytes;
  }

  get bytes(): number {
    return this.held;
  }

  get length(): number {
    return this.frames.length;
  }

  /** Arrival time of the oldest frame kept, or null when empty. */
  get oldestAt(): number | null {
    return this.frames[0]?.at ?? null;
  }

  /** Integer math: at / (1000 / fps) lands a hair under the boundary (29.9999). */
  private slot(at: number): number {
    return Math.floor((at * this.fps) / 1000);
  }

  push(frame: Frame): void {
    const last = this.frames[this.frames.length - 1];
    if (last && this.slot(last.at) === this.slot(frame.at)) {
      this.frames.pop();
      this.held -= last.data.length;
    }
    this.frames.push(frame);
    this.held += frame.data.length;
    this.trim(frame.at);
  }

  /** Drop what fell out of the window as of `now`. */
  trim(now: number): void {
    const start = now - this.windowMs;
    const count = this.frames.length;
    const size = (i: number): number => this.frames[i]?.data.length ?? 0;
    let drop = 0;
    let freed = 0;
    // frames[drop + 1] already covers the window start, so frames[drop] is not needed.
    while (drop + 1 < count && (this.frames[drop + 1]?.at ?? Infinity) <= start) freed += size(drop++);
    while (this.held - freed > this.maxBytes && drop + 1 < count) freed += size(drop++);
    if (drop === 0) return;
    this.held -= freed;
    this.frames = this.frames.slice(drop);
  }

  /**
   * The frames that show [from, now]: the one on screen at `from` (moved up
   * to `from`), then every later one. From before the oldest frame: everything.
   */
  clip(from: number): Frame[] {
    let first = 0;
    for (let i = 0; i < this.frames.length; i++) {
      const frame = this.frames[i];
      if (frame && frame.at <= from) first = i;
    }
    const out = this.frames.slice(first);
    const head = out[0];
    if (head && head.at < from) out[0] = { data: head.data, at: from };
    return out;
  }
}

// ---------------------------------------------------------------------------
// ffmpeg (Playwright's bundled build: VP8 webm or PNG, nothing else)
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

function revision(name: string): number {
  const n = Number(name.slice(name.lastIndexOf("-") + 1));
  return Number.isFinite(n) ? n : 0;
}

/** The newest `ffmpeg-<rev>/ffmpeg-*` binary in Playwright's cache, or null. */
export async function findPlaywrightFfmpeg(): Promise<string | null> {
  for (const dir of playwrightCacheDirs()) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const revs = entries
      .filter((e) => e.isDirectory() && e.name.startsWith("ffmpeg"))
      .map((e) => e.name)
      .sort((a, b) => revision(b) - revision(a));
    for (const rev of revs) {
      let files;
      try {
        files = await readdir(path.join(dir, rev), { withFileTypes: true });
      } catch {
        continue;
      }
      const exe = files.find(
        (f) =>
          f.isFile() &&
          f.name.startsWith("ffmpeg") &&
          (process.platform === "win32" ? f.name.endsWith(".exe") : !f.name.includes(".")),
      );
      if (exe) return path.join(dir, rev, exe.name);
    }
  }
  return null;
}

function even(n: number): number {
  return Math.max(2, Math.ceil(n / 2) * 2);
}

/**
 * recordVideo's VP8 settings, fed JPEGs over a pipe at a constant 25 fps.
 * One thread keeps up live; a ring encoded at save time gets more.
 */
export function vp8Args(file: string, size: { width: number; height: number }, threads = 1): string[] {
  const w = even(size.width);
  const h = even(size.height);
  return [
    "-loglevel", "error",
    "-f", "image2pipe", "-avioflags", "direct", "-fpsprobesize", "0", "-probesize", "32", "-analyzeduration", "0",
    "-framerate", String(OUTPUT_FPS), "-c:v", "mjpeg", "-i", "pipe:0",
    "-y", "-an", "-r", String(OUTPUT_FPS),
    "-c:v", "vp8", "-qmin", "0", "-qmax", "50", "-crf", "8", "-deadline", "realtime", "-speed", "8",
    "-b:v", "1M", "-threads", String(threads),
    "-vf", `pad=${w}:${h}:0:0:gray,crop=${w}:${h}:0:0`,
    file,
  ];
}

/** How often a live encoder writes out the held frame on a still page. */
const TOP_UP_MS = 200;

/**
 * One ffmpeg process writing one webm. Frames are paced by their timestamps;
 * `close` pads the last frame out to the stop time and waits for the file.
 * `live`: frames arrive in real time, so the held frame is topped up on a
 * timer and stop only has a fraction of a second left to encode.
 */
export class Vp8Encoder {
  readonly file: string;
  private readonly proc: ChildProcess;
  private readonly pacer = new FramePacer();
  private held: Buffer | null = null;
  private failed: string | null = null;
  private stderr = "";
  private readonly exited: Promise<number>;
  private readonly timer: ReturnType<typeof setInterval> | null;

  constructor(
    ffmpegPath: string,
    file: string,
    size: { width: number; height: number },
    opts: { live?: boolean; threads?: number } = {},
  ) {
    this.file = file;
    this.proc = spawn(ffmpegPath, vp8Args(file, size, opts.threads), {
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    });
    this.proc.stderr?.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-2000);
    });
    // EPIPE after ffmpeg died: the exit code and stderr carry the story.
    this.proc.stdin?.on("error", (err) => {
      this.failed ??= err.message;
    });
    this.exited = new Promise((resolve) => {
      this.proc.on("error", (err) => {
        this.failed ??= err.message;
        resolve(-1);
      });
      this.proc.on("close", (code) => resolve(code ?? -1));
    });
    this.timer = opts.live === true ? setInterval(() => this.topUp(Date.now()), TOP_UP_MS) : null;
    this.timer?.unref();
  }

  private topUp(at: number): void {
    if (this.held) this.write(this.held, this.pacer.fill(at / 1000));
  }

  /** Frames written to ffmpeg so far (after pacing). */
  get written(): number {
    return this.pacer.written;
  }

  /** A frame that reached the daemon at `at` (Date.now()). */
  push(jpeg: Buffer, at: number): void {
    const copies = this.pacer.advance(at / 1000);
    if (this.held) this.write(this.held, copies);
    this.held = jpeg;
  }

  private write(frame: Buffer, copies: number): void {
    const stdin = this.proc.stdin;
    if (!stdin || this.failed !== null || stdin.destroyed) return;
    for (let i = 0; i < copies; i++) stdin.write(frame);
  }

  /** Resolves once ffmpeg has taken what was written (a burst encode waits on it). */
  async drained(): Promise<void> {
    const stdin = this.proc.stdin;
    if (!stdin || !stdin.writableNeedDrain || this.failed !== null) return;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        stdin.off("drain", done);
        stdin.off("close", done);
        resolve();
      };
      stdin.on("drain", done);
      stdin.on("close", done);
    });
  }

  /** Pads the held frame out to `endAt` (Date.now()), closes stdin and waits for ffmpeg. */
  async close(endAt: number): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.held) this.write(this.held, this.pacer.finish(endAt / 1000));
    this.proc.stdin?.end();
    const code = await this.exited;
    if (code !== 0 || this.failed !== null) {
      const why = this.stderr.trim().split("\n").slice(-3).join(" | ") || this.failed || `exit ${code}`;
      throw { code: "internal", message: `ffmpeg failed writing ${this.file}: ${why}` };
    }
  }

  /** Abandon the file (start failed). */
  kill(): void {
    if (this.timer) clearInterval(this.timer);
    this.proc.stdin?.destroy();
    this.proc.kill();
  }
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

export interface CaptureOptions {
  size: { width: number; height: number };
}

/** A CDP screencast on one page; every frame is acked on arrival. */
export class PageScreencast {
  readonly page: Page;
  private readonly cdp: CDPSession;
  private ended = false;
  /** Frames Chrome has sent. */
  frames = 0;

  get stopped(): boolean {
    return this.ended;
  }

  private constructor(page: Page, cdp: CDPSession) {
    this.page = page;
    this.cdp = cdp;
  }

  static async start(
    context: BrowserContext,
    page: Page,
    opts: CaptureOptions,
    onFrame: (frame: Frame) => void,
  ): Promise<PageScreencast> {
    const cdp = await context.newCDPSession(page);
    const capture = new PageScreencast(page, cdp);
    cdp.on("Page.screencastFrame", (event) => {
      if (capture.ended) return;
      // Ack first: Chrome holds the next frame until this one is acked.
      cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => undefined);
      capture.frames++;
      onFrame({ data: Buffer.from(event.data, "base64"), at: Date.now() });
    });
    try {
      await cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: 70,
        maxWidth: opts.size.width,
        maxHeight: opts.size.height,
        // Every frame, always: Chrome sends frames only on damage, and
        // everyNthFrame 2 dropped 6 of 12 single repaints in a still page (a
        // click's result could go missing until the next repaint). The 30/60
        // choice is made downstream, where the last frame in a slot wins.
        everyNthFrame: 1,
      });
    } catch (err) {
      capture.ended = true;
      await cdp.detach().catch(() => undefined);
      throw err;
    }
    return capture;
  }

  /**
   * The current picture as a JPEG, outside the screencast: Chrome sends
   * screencast frames only on damage, so a still page sends none at start.
   */
  async snapshot(size: { width: number; height: number }): Promise<Frame> {
    const shot = await this.cdp.send("Page.captureScreenshot", {
      format: "jpeg",
      quality: 70,
      clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 },
    });
    return { data: Buffer.from(shot.data, "base64"), at: Date.now() };
  }

  /** Stops frames at once; safe on a closed page. */
  async stop(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    await this.cdp.send("Page.stopScreencast").catch(() => undefined);
    await this.cdp.detach().catch(() => undefined);
  }
}

/** Encodes buffered frames (a ring clip) into one webm ending at `endAt`; resolves with frames written. */
export async function encodeClip(
  ffmpegPath: string,
  file: string,
  size: { width: number; height: number },
  frames: readonly Frame[],
  endAt: number,
): Promise<number> {
  const encoder = new Vp8Encoder(ffmpegPath, file, size, { threads: 4 });
  for (const frame of frames) {
    encoder.push(frame.data, frame.at);
    await encoder.drained();
  }
  await encoder.close(endAt);
  return encoder.written;
}

// ---------------------------------------------------------------------------
// Processes and the system ffmpeg (mp4)
// ---------------------------------------------------------------------------

export interface ProcessResult {
  code: number;
  output: string;
}

/**
 * Runs an executable with no shell and no console window (windowsHide, every
 * stdio piped or ignored). `exe` must be a full path: without a shell,
 * Windows applies no PATHEXT, so resolve names with findOnPath first.
 */
export function runProcess(exe: string, args: string[], cwd?: string): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const proc = spawn(exe, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    const keep = (chunk: Buffer): void => {
      output = (output + chunk.toString()).slice(-20_000);
    };
    proc.stdout.on("data", keep);
    proc.stderr.on("data", keep);
    proc.on("error", (err) => resolve({ code: -1, output: `${output}${String(err)}` }));
    proc.on("close", (code) => resolve({ code: code ?? -1, output }));
  });
}

/**
 * `name` on PATH, or null. Windows looks for `.exe` only: a `.cmd` shim
 * cannot be spawned without a shell, and bx never spawns through one.
 */
export function findOnPath(name: string): string | null {
  const exts = process.platform === "win32" ? [".exe"] : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    for (const ext of exts) {
      const full = path.join(dir, name + ext);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

let x264: Promise<string | null> | null = null;

/** The system ffmpeg when it has libx264 (Playwright's build has no H.264), else null. Checked once. */
export function systemX264Ffmpeg(): Promise<string | null> {
  x264 ??= (async () => {
    const exe = findOnPath("ffmpeg");
    if (exe === null) return null;
    const probe = await runProcess(exe, ["-hide_banner", "-encoders"]);
    return probe.code === 0 && /\blibx264\b/.test(probe.output) ? exe : null;
  })();
  return x264;
}

/** webm → H.264 mp4 (about 4.5x smaller on app pages, plays inline in more places). */
export async function transcodeMp4(ffmpegPath: string, webm: string, mp4: string): Promise<void> {
  const result = await runProcess(ffmpegPath, [
    "-loglevel", "error", "-y", "-i", webm,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    mp4,
  ]);
  if (result.code !== 0) {
    throw { code: "internal", message: `mp4 encode failed: ${result.output.trim().split("\n").slice(-3).join(" | ")}` };
  }
}
