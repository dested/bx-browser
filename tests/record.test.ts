// Recording: the pure parts of `bx record` — transcript timing and format, and
// the harness nonce. No daemon, no browser, no ffmpeg.
//
//   bun test tests/record.test.ts

import { expect, test } from "bun:test";

import {
  formatOffset,
  harnessHtml,
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
