// Recording tab-selection: the pure decision behind `bx record stop`. No
// daemon, no browser, no ffmpeg — these lock in the fix for the wrong-tab bug
// (a looping animation on an idle tab used to win the recording by byte size).
//
//   bun test tests/record.test.ts

import { expect, test } from "bun:test";

import {
  selectRecordedVideo,
  tallyActionsByTab,
  type VideoCandidate,
} from "../src/daemon/record.ts";

function candidate(tab: number, bytes: number): VideoCandidate {
  return { tab, file: `tab-${tab}.webm`, bytes };
}

// ---------------------------------------------------------------------------
// tallyActionsByTab
// ---------------------------------------------------------------------------

test("tallyActionsByTab counts entries per tab and skips page-less ones", () => {
  const byTab = tallyActionsByTab([
    { tab: 5 },
    { tab: 5 },
    { tab: 5 },
    { tab: 2 },
    { tab: undefined }, // e.g. tabSelect before any page existed
    {},
  ]);
  expect(byTab.get(5)).toBe(3);
  expect(byTab.get(2)).toBe(1);
  expect(byTab.size).toBe(2);
});

// ---------------------------------------------------------------------------
// selectRecordedVideo — the bug and its guard
// ---------------------------------------------------------------------------

test("the driven tab wins over a larger idle tab (the wrong-tab bug)", () => {
  // The idle marketing tab's looping hero animation encodes to a much bigger
  // webm than the agent's busy-but-static admin tab. Byte size would pick the
  // idle tab; action activity must pick the driven one.
  const idle = candidate(1, 5_000_000);
  const driven = candidate(2, 900_000);
  const byTab = tallyActionsByTab([{ tab: 2 }, { tab: 2 }, { tab: 2 }, { tab: 2 }]);

  const selection = selectRecordedVideo([idle, driven], byTab);
  expect(selection.ok).toBe(true);
  if (!selection.ok) throw new Error("expected a driven-tab selection");
  expect(selection.source.tab).toBe(2);
  expect(selection.actions).toBe(4);
});

test("wrong-tab guard fires when the driven tab produced no video", () => {
  // Only the idle tab's video survived to disk, but tab 7 was the one driven —
  // shipping the idle video would be a silent blank walkthrough. Fail loudly.
  const idleOnly = [candidate(1, 4_000_000)];
  const byTab = tallyActionsByTab([{ tab: 7 }, { tab: 7 }, { tab: 7 }]);

  const selection = selectRecordedVideo(idleOnly, byTab);
  expect(selection.ok).toBe(false);
  if (selection.ok) throw new Error("expected the wrong-tab guard to fire");
  expect(selection.reason).toBe("wrong-tab");
  if (selection.reason !== "wrong-tab") throw new Error("unreachable");
  expect(selection.drivenActions).toBe(3);
});

test("a passive recording (no tabbed actions) falls back to byte size", () => {
  // Nothing was driven — no guard, pick the largest webm as before.
  const small = candidate(1, 100_000);
  const large = candidate(2, 800_000);

  const selection = selectRecordedVideo([small, large], new Map());
  expect(selection.ok).toBe(true);
  if (!selection.ok) throw new Error("expected a byte-size fallback selection");
  expect(selection.source.tab).toBe(2);
  expect(selection.actions).toBe(0);
});

test("equal action counts break the tie by byte size", () => {
  const a = { tab: 1, file: "a.webm", bytes: 300_000 };
  const b = { tab: 2, file: "b.webm", bytes: 900_000 };
  const byTab = tallyActionsByTab([{ tab: 1 }, { tab: 2 }]);

  const selection = selectRecordedVideo([a, b], byTab);
  expect(selection.ok).toBe(true);
  if (!selection.ok) throw new Error("expected a selection");
  expect(selection.source.tab).toBe(2);
});

test("the driven tab wins even when it is the smallest file", () => {
  const byTab = tallyActionsByTab([{ tab: 3 }, { tab: 3 }]);
  const selection = selectRecordedVideo(
    [candidate(1, 9_000_000), candidate(2, 6_000_000), candidate(3, 120_000)],
    byTab,
  );
  expect(selection.ok).toBe(true);
  if (!selection.ok) throw new Error("expected a selection");
  expect(selection.source.tab).toBe(3);
});

test("no candidates → no-video", () => {
  const selection = selectRecordedVideo([], tallyActionsByTab([{ tab: 1 }]));
  expect(selection.ok).toBe(false);
  if (selection.ok) throw new Error("expected no-video");
  expect(selection.reason).toBe("no-video");
});

test("a single zero-byte video → no-video, not wrong-tab", () => {
  // The one page that painted nothing is still the driven tab; there is simply
  // no usable video, so this is a capture failure, not a wrong-tab mixup.
  const selection = selectRecordedVideo([candidate(1, 0)], tallyActionsByTab([{ tab: 1 }]));
  expect(selection.ok).toBe(false);
  if (selection.ok) throw new Error("expected no-video");
  expect(selection.reason).toBe("no-video");
});
