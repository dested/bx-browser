// Screencast pacing: damage-driven frames become a constant 25 fps stream.
// No browser, no ffmpeg.
//
//   bun test tests/screencast.test.ts

import { expect, test } from "bun:test";

import { FramePacer, vp8Args } from "../src/daemon/screencast.ts";

test("the first frame writes nothing; it is held until the next one", () => {
  const pacer = new FramePacer(25);
  expect(pacer.advance(100)).toBe(0);
  expect(pacer.written).toBe(0);
});

test("a frame holds its slots until the next frame arrives", () => {
  const pacer = new FramePacer(25);
  pacer.advance(100);
  // 0.2 s later: slots 0..4 belong to the first frame.
  expect(pacer.advance(100.2)).toBe(5);
  // 1 s after start: slots 5..24 belong to the second.
  expect(pacer.advance(101)).toBe(20);
  expect(pacer.written).toBe(25);
});

test("frames inside one slot replace each other without writing", () => {
  const pacer = new FramePacer(25);
  pacer.advance(10);
  expect(pacer.advance(10.01)).toBe(0);
  expect(pacer.advance(10.03)).toBe(0);
  expect(pacer.advance(10.04)).toBe(1);
});

test("an out-of-order timestamp never writes a negative count", () => {
  const pacer = new FramePacer(25);
  pacer.advance(10);
  pacer.advance(11);
  expect(pacer.advance(10.5)).toBe(0);
  expect(pacer.written).toBe(25);
});

test("finish pads the held frame to the stop time, and writes at least one", () => {
  const pacer = new FramePacer(25);
  pacer.advance(0);
  pacer.advance(1);
  // Stop 2 s after the last frame: the video runs 3 s = 75 frames in all.
  expect(pacer.finish(3)).toBe(50);
  expect(pacer.written).toBe(75);

  const single = new FramePacer(25);
  single.advance(5);
  expect(single.finish(5)).toBe(1);
  expect(new FramePacer(25).finish(5)).toBe(0); // no frame ever arrived
});

test("a 10 s damage-only capture encodes to 10 s of video", () => {
  const pacer = new FramePacer(25);
  // ~3 fps of damage, as on a typical app page.
  for (let t = 0; t < 10; t += 0.33) pacer.advance(t);
  pacer.finish(10);
  expect(pacer.written).toBe(250);
});

test("vp8Args pads odd viewports to even sizes and ends with the file", () => {
  const args = vp8Args("out.webm", { width: 1279, height: 801 });
  expect(args.at(-1)).toBe("out.webm");
  expect(args).toContain("pad=1280:802:0:0:gray,crop=1280:802:0:0");
  expect(args).toContain("vp8");
});

test("fill tops up the held frame to now and keeps it held", () => {
  const pacer = new FramePacer(25);
  pacer.advance(0);
  expect(pacer.fill(0.5)).toBe(12);
  expect(pacer.fill(0.5)).toBe(0); // idempotent
  // The next real frame only adds the slots since the top-up.
  expect(pacer.advance(1)).toBe(13);
  expect(pacer.written).toBe(25);
});
