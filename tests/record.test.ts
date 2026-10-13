// Recording: the pure parts of `bx record` — transcript timing and format, the
// harness nonce, report wording and recording.json parsing. No daemon, no browser, no ffmpeg.
//
//   bun test tests/record.test.ts

import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { cmd, ensureDaemon, stopDaemon } from "../src/client.ts";
import type {
  Cmd,
  JsResult,
  RecordStartResult,
  RecordStatusResult,
  RecordStopResult,
  TabsResult,
} from "../src/protocol.ts";

import { actionLogWording, isRewordedFile, isVideoCopy } from "../src/daemon/harness/wording.ts";
import {
  formatOffset,
  harnessHtml,
  parsePackageMeta,
  requireNonce,
  transcriptLines,
  transcriptText,
} from "../src/daemon/record.ts";

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

test("formatOffset is mm:ss.mmm and keeps counting minutes", () => {
  expect(formatOffset(0)).toBe("00:00.000");
  expect(formatOffset(1234)).toBe("00:01.234");
  expect(formatOffset(61_005)).toBe("01:01.005");
  expect(formatOffset(3_600_000 + 999)).toBe("60:00.999");
  expect(formatOffset(-50)).toBe("00:00.000");
});

test("transcript offsets are measured from the video's first frame", () => {
  // The log counts from the daemon's t0 (origin); the video starts at zeroAt.
  const origin = 1_000_000;
  const zeroAt = 1_005_000;
  const lines = transcriptLines(
    [
      { t: 4_000, text: "opened /fixture", cmd: "open" }, // before the video: clamps to 0
      { t: 6_250, text: 'clicked "Save"', cmd: "click" },
      { t: 9_000, text: "checkout done", cmd: "recordMark" },
    ],
    origin,
    zeroAt,
  );
  expect(lines).toEqual([
    { t: 0, text: "opened /fixture" },
    { t: 1_250, text: 'clicked "Save"' },
    { t: 4_000, text: "— mark: checkout done" },
  ]);
});

test("transcript text says action log, one timed line per entry", () => {
  const text = transcriptText("demo", [
    { t: 0, text: "opened /fixture" },
    { t: 1_250, text: 'clicked "Save"' },
  ]);
  expect(text).toBe(
    "# demo — action log (bx commands, timed against video.webm)\n" +
      "[00:00.000] opened /fixture\n" +
      '[00:01.250] clicked "Save"\n',
  );
  expect(text).not.toMatch(/spoken|speaker/i);
  expect(transcriptText("idle", [])).toContain("(no actions)");
});

// ---------------------------------------------------------------------------
// Harness nonce (O5)
// ---------------------------------------------------------------------------

test("harness routes answer only requests carrying the distill's nonce", async () => {
  const route = requireNonce("abc-123", async () => new Response("ok"));
  expect((await route(new Request("http://127.0.0.1/harness/meta"))).status).toBe(404);
  expect((await route(new Request("http://127.0.0.1/harness/meta?n=wrong"))).status).toBe(404);
  const ok = await route(new Request("http://127.0.0.1/harness/meta?n=abc-123"));
  expect(ok.status).toBe(200);
  expect(await ok.text()).toBe("ok");
});

test("the harness page loads its bundle with the nonce and adds it to every /harness fetch", () => {
  const html = harnessHtml("abc-123");
  expect(html).toContain(`src="/harness.js?n=abc-123"`);
  expect(html).toContain(`const n = "abc-123"`);
  // The wrapper runs before the module script.
  expect(html.indexOf("window.fetch =")).toBeLessThan(html.indexOf('type="module"'));
});

// ---------------------------------------------------------------------------
// Report wording (harness/wording.ts): video-to-prompt output, verbatim from a
// pre-V1 package, must come out as an action log with no narration words
// ---------------------------------------------------------------------------

const LIBRARY_REPORT = "# Walkthrough — t1\n\n`walkthrough 0:04` · `4 keyframes` · `5 spoken lines` · recorded 2026-10-12 21:19–21:19\n\n> **You are reading a walkthrough — recorded feedback from a human using the running app: sometimes a bug, sometimes review notes, sometimes a change they want.**\n> Everything below sits on one timeline, in the order it happened — and the human\n> pruned and reordered it before handing it over, so what is here is what they meant\n> you to read. **Read the images:**\n> they are the primary evidence, and the words are shorthand that assumes you looked.\n> Every path is relative to the walkthrough's own file set — the paths inside the folder if you downloaded it. Wherever\n> this report caps or thins what it shows you it prints the count — when you see one,\n> you are looking at a subset, and the rest is in the walkthrough.\n>\n> The **walkthrough** is a narrated screen recording, distilled. Read it in this order:\n> first the **contact sheets** — nine keyframes per image, in order, covering the\n> *whole* recording at a fraction of the tokens — then the flow below, which is the same\n> recording as text. A full still is inlined only where the narration is pointing at\n> something; every other keyframe is listed by filename (`rec-NN/frames/NN-mmss.jpg`)\n> so you can open one when you need it. **The mmss inside a filename is time within\n> that file's own video** (`rec-NN/walkthrough.webm`); every time *printed* below is\n> a position on this report's single timeline, so the two do not have to match.\n> A spoken line covers a **window, not an\n> instant**: it is stamped where the speaker started talking, and people narrate what\n> just happened, so each line names the frames it is actually about — trust that range\n> over the stamp. An accent crosshair drawn on a frame is the mouse pointer, and\n> `pointer` under a frame names what it was over — that is how \"this one over here\"\n> resolves. It may have been recorded in more than one sitting; those are laid end to\n> end on a single clock, so every time below reads straight through and no arithmetic\n> is asked of you.\n\n**Video:** `rec-01/walkthrough.webm` (0:04) — the raw recording, for humans. Everything below is distilled from it.\n\n> The transcript is machine-transcribed (bx-action-log) and **was not checked by the speaker**.\n> Speech recognition mangles exactly the words that matter most — nouns, units, small numbers.\n> Where a word contradicts the frames or the code, believe the frames.\n\n### Contact sheets — read these first\n\n4 keyframes across 1 sheet, nine per image, in order, each tile labeled with its filename.\n\n";

const LIBRARY_MANIFEST = "source: video-to-prompt — t1\nrecorded: 2026-10-12 21:19 | 1 part(s)\nnote: every path below is relative to this walkthrough\n--- files ---\nreport.md                the whole walkthrough in order, on one timeline. read this one\nMANIFEST.txt             this listing\nrec-01/                  part 1 — walkthrough, 4s, 5 spoken line(s)\nrec-01/frames/           4 keyframes, NN-mmss.jpg (the mmss is time inside this part's own walkthrough.webm, not a position in report.md's timeline) — 1s candidates + dedup, deduped from 4 sampled\nrec-01/grids/            1 contact sheet(s), 9 frames each, in order\nrec-01/transcript.txt    bx-action-log — NOT checked by the speaker; treat wording as approximate\nrec-01/recording.json    frame times, pointer positions, transcript windows, 0 error(s)\nrec-01/walkthrough.webm  raw video (for humans)\nnote: line stamps are where the speaker started; the bracketed range is the window the line is about\n--- transcript: rec-01 (0:04) ---\n[0:01–0:02] filled \"#email\" with \"demo@taskbox.test\"\n[0:01–0:03] filled \"#password\" with \"•••\"\n[0:02–0:03] clicked \"Sign in\"\n[0:02–0:03] clicked \"Settings\"\n[0:02–0:04] clicked \"Tasks\"\n";

test("the report reads as an action log: no spoken, speaker or speech recognition", () => {
  const out = actionLogWording(LIBRARY_REPORT);
  expect(out).not.toMatch(/spoken|speaker|speech/i);
  expect(out).toContain("# Recording — t1");
  expect(out).toContain("You are reading a bx recording");
  expect(out).toContain("bx's action log");
  expect(out).toContain("`5 action-log lines`");
  // The video is the package's own, never the library's copy.
  expect(out).toContain("`video.webm`");
  expect(out).not.toContain("walkthrough.webm");
  // The rest of the report is untouched.
  expect(out).toContain("### Contact sheets — read these first");
});

test("the manifest drops the speaker notes and points at video.webm", () => {
  const out = actionLogWording(LIBRARY_MANIFEST);
  expect(out).not.toMatch(/spoken|speaker|speech/i);
  expect(out).toContain("5 action-log line(s)");
  expect(out).toContain("bx-action-log — exact");
  expect(out).toContain("line stamps are when the bx command finished");
  expect(out).toContain("video.webm  raw video (for humans)");
});

test("only the text files are reworded, and the library's webm copy is skipped", () => {
  expect(isRewordedFile("report.md")).toBe(true);
  expect(isRewordedFile("MANIFEST.txt")).toBe(true);
  expect(isRewordedFile("rec-01/transcript.txt")).toBe(true);
  expect(isRewordedFile("rec-01/recording.json")).toBe(false);
  expect(isRewordedFile("rec-01/frames/01-0000.jpg")).toBe(false);
  expect(isVideoCopy("rec-01/walkthrough.webm")).toBe(true);
  expect(isVideoCopy("rec-01/grids/grid_01.jpg")).toBe(false);
});

// ---------------------------------------------------------------------------
// recording.json (recordDistill re-reads it)
// ---------------------------------------------------------------------------

test("parsePackageMeta reads a package's slug, duration and timed lines", () => {
  const meta = parsePackageMeta({
    slug: "demo",
    durationMs: 8000,
    frames: 12,
    actions: [{ t: 0, text: "opened /fixture" }, { t: "bad" }, { t: 1250, text: 'clicked "Save"' }],
  });
  expect(meta).toEqual({
    slug: "demo",
    durationMs: 8000,
    frames: 12,
    lines: [
      { t: 0, text: "opened /fixture" },
      { t: 1250, text: 'clicked "Save"' },
    ],
  });
  expect(parsePackageMeta({ slug: "x" })).toBeNull();
  expect(parsePackageMeta(null)).toBeNull();
});

// ---------------------------------------------------------------------------
// Live: a real daemon on your own profile. Skipped unless BX_RECORD_LIVE names
// the profile (never "default"):
//
//   BX_RECORD_LIVE=recorder-dev bun test tests/record.test.ts
// ---------------------------------------------------------------------------

const LIVE = process.env.BX_RECORD_LIVE;
const live = test.skipIf(LIVE === undefined || LIVE === "" || LIVE === "default");
const LIVE_MS = 90_000;

async function liveCmd<T>(c: Cmd): Promise<T> {
  const res = await cmd<T>(LIVE ?? "", c);
  if (!res.ok) throw new Error(`${c.cmd} failed: ${res.error.code} — ${res.error.message}`);
  return res.data;
}

/** Waits until no package is still distilling. */
async function distilled(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while ((await liveCmd<RecordStatusResult>({ cmd: "recordStatus" })).distilling.length > 0) {
    if (Date.now() > deadline) throw new Error("distill still running after 60 s");
    await Bun.sleep(250);
  }
}

function isWebm(file: string): boolean {
  const head = readFileSync(file).subarray(0, 4);
  return head.equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
}

let liveOut = "";
let loginTab = 0;
let otherTab = 0;
let livePort = 0;

live("live: setup — the fixture login with a typed value, and a second tab", async () => {
  await stopDaemon(LIVE ?? "");
  const run = await ensureDaemon(LIVE ?? "", { headless: true });
  livePort = run.port;
  liveOut = mkdtempSync(path.join(os.tmpdir(), "bx-record-"));
  await liveCmd({ cmd: "open", url: `http://127.0.0.1:${run.port}/fixture/#/login` });
  await liveCmd({ cmd: "fill", target: { testid: "email" }, value: "typed@record.test" });
  await liveCmd({ cmd: "js", expression: "window.__kept = 42" });
  const tabs = await liveCmd<TabsResult>({ cmd: "tabNew", background: true });
  otherTab = tabs.created?.id ?? 0;
  loginTab = tabs.pages.find((p) => p.active)?.id ?? 0;
  expect(otherTab).toBeGreaterThan(0);
  expect(loginTab).toBeGreaterThan(0);
}, LIVE_MS);

live("live: start/mark/stop keeps tabs and typed state; the package lands, report in the background", async () => {
  const start = await liveCmd<RecordStartResult>({ cmd: "recordStart", slug: "live-basic" });
  expect(start.tab).toBe(loginTab);
  expect(start.firstFrameMs).toBeLessThan(1000);
  await liveCmd({ cmd: "fill", target: { testid: "password" }, value: "hunter2" });
  const marked = await liveCmd<RecordStatusResult>({ cmd: "recordMark", text: "after the password" });
  expect(marked.marks).toBe(1);
  await liveCmd({ cmd: "press", key: "Tab" });
  await Bun.sleep(500);

  const dir = path.join(liveOut, "live-basic");
  const t = performance.now();
  const stop = await liveCmd<RecordStopResult>({ cmd: "recordStop", outDir: dir });
  expect(performance.now() - t).toBeLessThan(2000);
  expect(stop.distill).toBe("running");
  expect(isWebm(stop.videoPath)).toBe(true);
  const transcript = readFileSync(stop.transcriptPath, "utf8");
  expect(transcript).toContain("— mark: after the password");
  expect(transcript).toContain("pressed Tab");

  await distilled();
  const report = readFileSync(stop.reportPath, "utf8");
  expect(report).not.toMatch(/spoken|speaker|speech/i);
  expect(existsSync(path.join(dir, "rec-01", "walkthrough.webm"))).toBe(false);

  const tabs = await liveCmd<TabsResult>({ cmd: "tabs" });
  expect(tabs.pages.map((p) => p.id)).toEqual([loginTab, otherTab]);
  const value = await liveCmd<JsResult>({ cmd: "js", expression: "document.querySelector('[data-testid=email]').value + ' ' + window.__kept" });
  expect(value.value).toBe(JSON.stringify("typed@record.test 42"));
}, LIVE_MS);

live("live: ring mode saves the last seconds while capture goes on", async () => {
  const start = await liveCmd<RecordStartResult>({ cmd: "recordStart", slug: "live-ring", ring: 30 });
  expect(start.ring).toBe(30);
  for (let i = 0; i < 4; i++) {
    await liveCmd({ cmd: "fill", target: { testid: "email" }, value: `ring-${i}@record.test` });
    await Bun.sleep(600);
  }
  const save = await liveCmd<RecordStopResult>({ cmd: "recordSave", lastSecs: 1, outDir: path.join(liveOut, "live-ring-save") });
  expect(save.durationMs).toBeLessThanOrEqual(1100);
  expect(isWebm(save.videoPath)).toBe(true);
  const saved = readFileSync(save.transcriptPath, "utf8");
  expect(saved).toContain("ring-3@");
  expect(saved).not.toContain("ring-0@");
  const status = await liveCmd<RecordStatusResult>({ cmd: "recordStatus" });
  expect(status.recording).toBe(true);
  expect(status.bufferedBytes ?? 0).toBeGreaterThan(0);
  const stop = await liveCmd<RecordStopResult>({ cmd: "recordStop", outDir: path.join(liveOut, "live-ring") });
  expect(stop.durationMs).toBeGreaterThan(2000);
  expect(readFileSync(stop.transcriptPath, "utf8")).toContain("ring-3@");
  await distilled();
}, LIVE_MS);

live("live: --follow moves the capture with the active tab", async () => {
  await liveCmd({ cmd: "recordStart", slug: "live-follow", follow: true });
  await liveCmd({ cmd: "tabSelect", index: 1 });
  await Bun.sleep(300);
  expect((await liveCmd<RecordStatusResult>({ cmd: "recordStatus" })).tab).toBe(otherTab);
  await liveCmd({ cmd: "tabSelect", index: 0 });
  await Bun.sleep(300);
  const stop = await liveCmd<RecordStopResult>({ cmd: "recordStop", outDir: path.join(liveOut, "live-follow") });
  const meta: unknown = JSON.parse(readFileSync(stop.metaPath, "utf8"));
  const tabs = typeof meta === "object" && meta !== null && "tabs" in meta && Array.isArray(meta.tabs) ? meta.tabs : [];
  expect(tabs.map((span: unknown) => (typeof span === "object" && span !== null && "tab" in span ? span.tab : null))).toEqual([
    loginTab,
    otherTab,
    loginTab,
  ]);
  await distilled();
}, LIVE_MS);

live("live: --follow picks up a tab opened in front (bx run --record's first step)", async () => {
  await liveCmd({ cmd: "recordStart", slug: "live-fresh", follow: true });
  const opened = await liveCmd<TabsResult>({ cmd: "tabNew" });
  const fresh = opened.created?.id ?? 0;
  await liveCmd({ cmd: "open", url: `http://127.0.0.1:${livePort}/fixture/#/login` });
  await Bun.sleep(300);
  expect((await liveCmd<RecordStatusResult>({ cmd: "recordStatus" })).tab).toBe(fresh);
  const stop = await liveCmd<RecordStopResult>({ cmd: "recordStop", outDir: path.join(liveOut, "live-fresh") });
  expect(readFileSync(stop.metaPath, "utf8")).toContain(`"tab": ${fresh}`);
  await liveCmd({ cmd: "tabClose", tab: fresh });
  await liveCmd({ cmd: "tabSelect", index: 0 });
  await distilled();
}, LIVE_MS);

live("live: a recorded tab that closes ends with a mark; stop still packages", async () => {
  const tabs = await liveCmd<TabsResult>({ cmd: "tabNew", background: true });
  const doomed = tabs.created?.id ?? 0;
  await liveCmd({ cmd: "recordStart", slug: "live-closed", tab: doomed });
  await liveCmd({ cmd: "tabClose", tab: doomed });
  const stop = await liveCmd<RecordStopResult>({ cmd: "recordStop", outDir: path.join(liveOut, "live-closed") });
  expect(readFileSync(stop.metaPath, "utf8")).toContain(`tab ${doomed} closed`);
  await distilled();
}, LIVE_MS);

live("live: --mp4 writes an H.264 copy when ffmpeg has libx264, else bad_request before stopping", async () => {
  await liveCmd({ cmd: "recordStart", slug: "live-mp4" });
  await Bun.sleep(500);
  const res = await cmd<RecordStopResult>(LIVE ?? "", { cmd: "recordStop", outDir: path.join(liveOut, "live-mp4"), mp4: true });
  if (res.ok) {
    expect(res.data.mp4Path).toBeDefined();
    expect(existsSync(res.data.mp4Path ?? "")).toBe(true);
  } else {
    expect(res.error.code).toBe("bad_request");
    // The recording survived the refusal.
    await liveCmd({ cmd: "recordStop", outDir: path.join(liveOut, "live-mp4") });
  }
  await distilled();
  await stopDaemon(LIVE ?? "");
  rmSync(liveOut, { recursive: true, force: true });
}, LIVE_MS);
