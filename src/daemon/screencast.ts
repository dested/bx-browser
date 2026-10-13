// Recording capture core: CDP Page.startScreencast on one page, JPEG frames
// piped into our own ffmpeg (Playwright's bundled build, VP8 webm). Nothing
// here relaunches or reconfigures the browser context, so tabs, typed values
// and page ids survive a recording. Playwright's recordVideo and
// page.screencast must never run on a page this captures.
//
// Node runtime (like the rest of src/daemon): node:* only, no Bun.*.

import { spawn, type ChildProcess } from "node:child_process";
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

/** recordVideo's VP8 settings, fed JPEGs over a pipe at a constant 25 fps. */
export function vp8Args(file: string, size: { width: number; height: number }): string[] {
  const w = even(size.width);
  const h = even(size.height);
  return [
    "-loglevel", "error",
    "-f", "image2pipe", "-avioflags", "direct", "-fpsprobesize", "0", "-probesize", "32", "-analyzeduration", "0",
    "-framerate", String(OUTPUT_FPS), "-c:v", "mjpeg", "-i", "pipe:0",
    "-y", "-an", "-r", String(OUTPUT_FPS),
    "-c:v", "vp8", "-qmin", "0", "-qmax", "50", "-crf", "8", "-deadline", "realtime", "-speed", "8",
    "-b:v", "1M", "-threads", "1",
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

  constructor(ffmpegPath: string, file: string, size: { width: number; height: number }, opts: { live?: boolean } = {}) {
    this.file = file;
    this.proc = spawn(ffmpegPath, vp8Args(file, size), {
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
  private stopped = false;
  /** Frames Chrome has sent. */
  frames = 0;

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
      if (capture.stopped) return;
      // Ack first: Chrome holds the next frame until this one is acked.
      cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => undefined);
      capture.frames++;
      onFrame({ data: Buffer.from(event.data, "base64"), at: Date.now() });
    });
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
    if (this.stopped) return;
    this.stopped = true;
    await this.cdp.send("Page.stopScreencast").catch(() => undefined);
    await this.cdp.detach().catch(() => undefined);
  }
}
