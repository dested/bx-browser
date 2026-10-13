// Recording: the pure parts of `bx record` — transcript timing and format, the
// harness nonce, report wording and recording.json parsing. No daemon, no browser, no ffmpeg.
//
//   bun test tests/record.test.ts

import { expect, test } from "bun:test";

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
