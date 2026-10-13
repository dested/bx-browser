// Console/network buffers: the circular ring, per-tab filtering, the default
// resource types and the regex fallback. No daemon, no browser.
//
//   bun test tests/observe.test.ts

import { expect, test } from "bun:test";

import {
  RingBuffer,
  filterRegex,
  newErrorsSince,
  queryConsole,
  queryNet,
} from "../src/daemon/observe.ts";
import type { ConsoleEntry, NetEntry } from "../src/protocol.ts";

test("RingBuffer keeps the newest cap entries in order and counts every push", () => {
  const ring = new RingBuffer<number>(3);
  for (let i = 1; i <= 7; i++) ring.push(i);
  expect(ring.toArray()).toEqual([5, 6, 7]);
  expect(ring.length).toBe(7);
  expect(ring.size).toBe(3);
  expect(ring.since(6)).toEqual([7]);
  expect(ring.since(2)).toEqual([5, 6, 7]); // evicted entries are simply gone
  expect(ring.since(7)).toEqual([]);
});

test("an invalid filter regex matches as plain text", () => {
  expect(filterRegex("a(b").test("xa(by")).toBe(true);
  expect(filterRegex("^api/").test("API/users")).toBe(true);
});

function consoleEntry(tab: number, level: ConsoleEntry["level"], text: string): ConsoleEntry {
  return { t: 0, tab, level, text, url: "" };
}

test("console filters to a tab, and errors-since honours the action's tab", () => {
  const ring = new RingBuffer<ConsoleEntry>(50);
  ring.push(consoleEntry(1, "error", "one broke"));
  const mark = ring.length;
  ring.push(consoleEntry(2, "error", "two broke"));
  ring.push(consoleEntry(1, "log", "one says hi"));
  ring.push(consoleEntry(1, "pageerror", "one threw"));
  expect(queryConsole(ring, { tab: 1 }).map((e) => e.text)).toEqual(["one broke", "one threw"]);
  expect(queryConsole(ring, { tab: 1, all: true })).toHaveLength(3);
  expect(queryConsole(ring, {})).toHaveLength(3);
  expect(newErrorsSince(ring, mark, 1)).toEqual(["one threw"]);
  expect(newErrorsSince(ring, mark)).toEqual(["two broke", "one threw"]);
});

function netEntry(id: number, tab: number, resourceType: string, url: string, status = 200): NetEntry {
  return { id, tab, resourceType, t: 0, method: "GET", url, status, ms: 1, failed: status >= 400 };
}

test("net shows documents, xhr and fetch by default, everything with all", () => {
  const ring = new RingBuffer<NetEntry>(50);
  ring.push(netEntry(1, 1, "document", "/"));
  ring.push(netEntry(2, 1, "script", "/app.js"));
  ring.push(netEntry(3, 1, "fetch", "/api/tasks", 500));
  ring.push(netEntry(4, 2, "xhr", "/api/other"));
  ring.push(netEntry(5, 1, "image", "/logo.png"));
  expect(queryNet(ring, {}).map((e) => e.id)).toEqual([1, 3, 4]);
  expect(queryNet(ring, { all: true }).map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);
  expect(queryNet(ring, { tab: 1 }).map((e) => e.id)).toEqual([1, 3]);
  expect(queryNet(ring, { failed: true }).map((e) => e.id)).toEqual([3]);
  expect(queryNet(ring, { filter: "api/(", all: true }).map((e) => e.id)).toEqual([]);
  expect(queryNet(ring, { filter: "^/api" }).map((e) => e.id)).toEqual([3, 4]);
});
