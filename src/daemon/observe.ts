// Console + network observation. One pair of ring buffers per session, shared
// across every page; each entry carries the tab that produced it, so a pinned
// caller sees only its own tab while `bx console` / `bx net` (unpinned) still
// answer session-wide questions.

import {
  BUDGET,
  type ConsoleEntry,
  type NetBodyResult,
  type NetEntry,
} from "../protocol.ts";
import type { Page, Request, Response } from "playwright-core";

const TEXT_CAP = 400;
const URL_CAP = 200;
/** Responses whose bodies `netBody` can still fetch: the newest this many. */
const BODY_KEEP = 200;
/** What `bx net` shows without `all`: the requests an app's logic makes. */
const DEFAULT_NET_TYPES: ReadonlySet<string> = new Set(["document", "xhr", "fetch"]);

/** Fixed-capacity circular buffer. `length` is the monotonic push count, not the size. */
export class RingBuffer<T> {
  private readonly slots: (T | undefined)[];
  private pushed = 0;
  private readonly cap: number;

  constructor(cap: number) {
    this.cap = Math.max(1, cap);
    this.slots = new Array<T | undefined>(this.cap);
  }

  push(item: T): void {
    this.slots[this.pushed % this.cap] = item;
    this.pushed++;
  }

  /** Entries kept right now. */
  get size(): number {
    return Math.min(this.pushed, this.cap);
  }

  toArray(): T[] {
    return this.since(0);
  }

  /** Entries pushed after `mark`, minus any already evicted. */
  since(mark: number): T[] {
    const from = Math.max(mark, this.pushed - this.size);
    const out: T[] = [];
    for (let i = from; i < this.pushed; i++) {
      const item = this.slots[i % this.cap];
      if (item !== undefined) out.push(item);
    }
    return out;
  }

  get length(): number {
    return this.pushed;
  }
}

/**
 * Response handles for `netBody`, keyed by NetEntry id. Weak, and only the
 * newest BODY_KEEP: a body is fetched on demand from Chrome while its page
 * lives, never copied into the daemon.
 */
export class ResponseStore {
  private nextId = 1;
  private readonly refs = new Map<number, WeakRef<Response>>();

  /** The id the next NetEntry gets. Every entry gets one, response or not. */
  take(): number {
    return this.nextId++;
  }

  keep(id: number, response: Response): void {
    this.refs.set(id, new WeakRef(response));
    // Map iteration is insertion order: the first key is the oldest.
    while (this.refs.size > BODY_KEEP) {
      const oldest = this.refs.keys().next();
      if (oldest.done === true) break;
      this.refs.delete(oldest.value);
    }
  }

  get(id: number): Response | undefined {
    return this.refs.get(id)?.deref();
  }

  get kept(): number {
    return this.refs.size;
  }
}

export interface Buffers {
  console: RingBuffer<ConsoleEntry>;
  net: RingBuffer<NetEntry>;
  t0: number;
  /** Optional only so an older Buffers literal still type-checks; createBuffers sets it. */
  bodies?: ResponseStore;
}

export function createBuffers(): Buffers {
  return {
    console: new RingBuffer<ConsoleEntry>(BUDGET.RING_BUFFER_SIZE),
    net: new RingBuffer<NetEntry>(BUDGET.RING_BUFFER_SIZE),
    t0: Date.now(),
    bodies: new ResponseStore(),
  };
}

function bodiesOf(buffers: Buffers): ResponseStore {
  buffers.bodies ??= new ResponseStore();
  return buffers.bodies;
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

/** `tab` is the page's stable id; every entry it produces carries it. */
export function attachObservers(page: Page, buffers: Buffers, tab?: number): void {
  const started = new WeakMap<Request, number>();
  const bodies = bodiesOf(buffers);

  page.on("console", (msg) => {
    buffers.console.push({
      t: Date.now() - buffers.t0,
      tab,
      level: consoleLevel(msg.type()),
      text: msg.text().slice(0, TEXT_CAP),
      url: page.url(),
    });
  });

  page.on("pageerror", (err) => {
    buffers.console.push({
      t: Date.now() - buffers.t0,
      tab,
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
      const response = aborted ? null : await req.response();
      const status = response?.status() ?? 0;
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
      const id = bodies.take();
      if (response) bodies.keep(id, response);
      buffers.net.push({
        id,
        tab,
        resourceType: req.resourceType(),
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

function escapeRegExp(s: string): string {
  return s.replace(/[\\^$*+?.()|[\]{}]/g, "\\$&");
}

/** Case-insensitive; an invalid pattern matches as plain text instead of throwing. */
export function filterRegex(source: string): RegExp {
  try {
    return new RegExp(source, "i");
  } catch {
    return new RegExp(escapeRegExp(source), "i");
  }
}

/**
 * `tab`: keep only that tab's entries. The session passes the command's pin
 * unless `allTabs` is set; unpinned commands pass nothing and see every tab.
 */
export function queryConsole(
  buffer: RingBuffer<ConsoleEntry>,
  opts: { all?: boolean; filter?: string; tab?: number },
): ConsoleEntry[] {
  let entries = buffer.toArray();
  if (opts.tab !== undefined) entries = entries.filter((e) => e.tab === opts.tab);
  if (!opts.all) {
    entries = entries.filter(
      (e) => e.level === "warn" || e.level === "error" || e.level === "pageerror",
    );
  }
  if (opts.filter !== undefined && opts.filter !== "") {
    const re = filterRegex(opts.filter);
    entries = entries.filter((e) => re.test(e.text));
  }
  return entries.slice(-BUDGET.CONSOLE_MAX_ENTRIES);
}

/** `all`: every resource type; otherwise documents, xhr and fetch only. */
export function queryNet(
  buffer: RingBuffer<NetEntry>,
  opts: { failed?: boolean; filter?: string; all?: boolean; tab?: number },
): NetEntry[] {
  let entries = buffer.toArray();
  if (opts.tab !== undefined) entries = entries.filter((e) => e.tab === opts.tab);
  if (!opts.all) {
    entries = entries.filter(
      (e) => e.resourceType === undefined || DEFAULT_NET_TYPES.has(e.resourceType),
    );
  }
  if (opts.failed) entries = entries.filter((e) => e.failed);
  if (opts.filter !== undefined && opts.filter !== "") {
    const re = filterRegex(opts.filter);
    entries = entries.filter((e) => re.test(e.url));
  }
  return entries.slice(-BUDGET.NET_MAX_ENTRIES);
}

/** Content types whose bodies are text worth showing a model. */
function isTextual(contentType: string): boolean {
  const type = contentType.toLowerCase();
  return (
    type === "" ||
    type.startsWith("text/") ||
    /\b(json|javascript|ecmascript|xml|x-www-form-urlencoded|graphql|csv|svg)\b/.test(type)
  );
}

/** One NetEntry's response body, fetched from Chrome while its page still lives. */
export async function netBody(buffers: Buffers, id: number): Promise<NetBodyResult> {
  const entry = buffers.net.toArray().find((e) => e.id === id);
  if (!entry) {
    throw { code: "bad_request", message: `no net entry ${id} (only the newest ${BUDGET.RING_BUFFER_SIZE} are kept) — run net again` };
  }
  const response = bodiesOf(buffers).get(id);
  if (!response) {
    throw {
      code: "no_page",
      message: entry.status === 0
        ? `net entry ${id} never got a response (${entry.failed ? "failed or aborted" : "no body"})`
        : `the body of net entry ${id} is gone (its page closed, or it is older than the newest ${BODY_KEEP})`,
    };
  }
  const contentType = response.headers()["content-type"] ?? "";
  if (!isTextual(contentType)) {
    throw { code: "bad_request", message: `net entry ${id} is ${contentType} — only text bodies are returned` };
  }
  let raw: Buffer;
  try {
    raw = await response.body();
  } catch {
    throw { code: "no_page", message: `the body of net entry ${id} is no longer available (the page navigated or closed)` };
  }
  const text = raw.toString("utf8");
  const truncated = text.length > BUDGET.TEXT_MAX_CHARS;
  return {
    id,
    url: response.url(),
    status: response.status(),
    contentType,
    body: truncated ? text.slice(0, BUDGET.TEXT_MAX_CHARS) : text,
    truncated,
  };
}

export function markConsole(buffer: RingBuffer<ConsoleEntry>): number {
  return buffer.length;
}

/** `tab`: only errors from that tab (an action's own page). */
export function newErrorsSince(buffer: RingBuffer<ConsoleEntry>, mark: number, tab?: number): string[] {
  return buffer
    .since(mark)
    .filter((e) => e.level === "error" || e.level === "pageerror")
    .filter((e) => tab === undefined || e.tab === tab)
    .map((e) => e.text);
}
