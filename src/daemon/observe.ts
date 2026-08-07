// Console + network observation. One pair of ring buffers per session, shared
// across every page so `bx console` / `bx net` answer session-wide questions.

import { BUDGET, type ConsoleEntry, type NetEntry } from "../protocol.ts";
import type { Page, Request } from "playwright-core";

const TEXT_CAP = 400;
const URL_CAP = 200;

/** Fixed-capacity buffer. `length` is the monotonic push count, not the size. */
export class RingBuffer<T> {
  private readonly items: T[] = [];
  private pushed = 0;
  private readonly cap: number;

  constructor(cap: number) {
    this.cap = cap;
  }

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.cap) this.items.shift();
    this.pushed++;
  }

  toArray(): T[] {
    return [...this.items];
  }

  /** Entries pushed after `mark`, minus any already evicted. */
  since(mark: number): T[] {
    const oldest = this.pushed - this.items.length;
    return this.items.slice(Math.max(0, mark - oldest));
  }

  get length(): number {
    return this.pushed;
  }
}

export interface Buffers {
  console: RingBuffer<ConsoleEntry>;
  net: RingBuffer<NetEntry>;
  t0: number;
}

function consoleLevel(type: string): ConsoleEntry["level"] {
  switch (type) {
    case "warning":
      return "warn";
    case "error":
      return "error";
    case "info":
      return "info";
    case "log":
      return "log";
    default:
      return "log";
  }
}

export function attachObservers(page: Page, buffers: Buffers): void {
  const started = new WeakMap<Request, number>();

  page.on("console", (msg) => {
    buffers.console.push({
      t: Date.now() - buffers.t0,
      level: consoleLevel(msg.type()),
      text: msg.text().slice(0, TEXT_CAP),
      url: page.url(),
    });
  });

  page.on("pageerror", (err) => {
    buffers.console.push({
      t: Date.now() - buffers.t0,
      level: "pageerror",
      text: err.message.slice(0, TEXT_CAP),
      url: page.url(),
    });
  });

  page.on("request", (req) => {
    started.set(req, Date.now());
  });

  const record = async (req: Request, aborted: boolean): Promise<void> => {
    try {
      const status = aborted ? 0 : ((await req.response())?.status() ?? 0);
      let ms = 0;
      try {
        const timing = req.timing();
        if (timing.responseEnd > 0) ms = Math.round(timing.responseEnd);
      } catch {
        // timing is unavailable for requests that never reached the network
      }
      if (ms <= 0) {
        const t0 = started.get(req);
        ms = t0 === undefined ? 0 : Date.now() - t0;
      }
      buffers.net.push({
        t: Date.now() - buffers.t0,
        method: req.method(),
        url: req.url().slice(0, URL_CAP),
        status,
        ms,
        failed: aborted || status >= 400,
      });
    } catch {
      // page torn down mid-flight; the entry is not worth surfacing
    }
  };

  page.on("requestfinished", (req) => {
    void record(req, false);
  });
  page.on("requestfailed", (req) => {
    void record(req, true);
  });
}

export function queryConsole(
  buffer: RingBuffer<ConsoleEntry>,
  opts: { all?: boolean; filter?: string },
): ConsoleEntry[] {
  let entries = buffer.toArray();
  if (!opts.all) {
    entries = entries.filter(
      (e) => e.level === "warn" || e.level === "error" || e.level === "pageerror",
    );
  }
  if (opts.filter !== undefined && opts.filter !== "") {
    const re = new RegExp(opts.filter, "i");
    entries = entries.filter((e) => re.test(e.text));
  }
  return entries.slice(-BUDGET.CONSOLE_MAX_ENTRIES);
}

export function queryNet(
  buffer: RingBuffer<NetEntry>,
  opts: { failed?: boolean; filter?: string },
): NetEntry[] {
  let entries = buffer.toArray();
  if (opts.failed) entries = entries.filter((e) => e.failed);
  if (opts.filter !== undefined && opts.filter !== "") {
    const re = new RegExp(opts.filter, "i");
    entries = entries.filter((e) => re.test(e.url));
  }
  return entries.slice(-BUDGET.NET_MAX_ENTRIES);
}

export function markConsole(buffer: RingBuffer<ConsoleEntry>): number {
  return buffer.length;
}

export function newErrorsSince(buffer: RingBuffer<ConsoleEntry>, mark: number): string[] {
  return buffer
    .since(mark)
    .filter((e) => e.level === "error" || e.level === "pageerror")
    .map((e) => e.text);
}
