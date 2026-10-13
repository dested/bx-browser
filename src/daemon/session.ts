// The browser session: one persistent Chrome context per profile, lazily
// launched, plus the ref registry that makes `bx click 3` work.

import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BUDGET,
  BX_DIR_NAME,
  PROFILES_DIR,
  SNAPS_DIR,
  type ActionLogEntry,
  type ActionLogResult,
  type ActionDelta,
  type ActionResult,
  type Cmd,
  type ConsoleEntry,
  type DebugPage,
  type DebugPageMetrics,
  type DebugResult,
  type DriveResult,
  type El,
  type ElsResult,
  type ExpectResult,
  type JsResult,
  type NetBodyResult,
  type NetEntry,
  type OpenResult,
  type PageInfo,
  type RefEntry,
  type SnapResult,
  type StatusResult,
  type TabsResult,
  type Target,
  type TextResult,
} from "../protocol.ts";
import { ACTION_LOG_CAP, ActionLog } from "./actionLog.ts";
import { distillPage, renderEls, type DistillResult } from "./distill.ts";
import { seedOsPasswordCheck } from "./osPassword.ts";
import { jsFunctionSource, jsProgram } from "./serialize.ts";
import {
  attachObservers,
  createBuffers,
  markConsole,
  netBody,
  newErrorsSince,
  queryConsole,
  queryNet,
  type Buffers,
} from "./observe.ts";
import { clearProfileLocks, describeClear } from "./orphans.ts";
import { recordingSlug } from "./record.ts";
import type { BrowserContext, CDPSession, Locator, Page, Request } from "playwright-core";

type CmdOf<K extends Cmd["cmd"]> = Extract<Cmd, { cmd: K }>;
type ActionThen = NonNullable<CmdOf<"click">["then"]>;

/** An action command's `then`, `until` and timeout (A2); none for the rest. */
function actionExtras(cmd: Cmd | null): { then?: ActionThen; until?: string; timeoutMs?: number } {
  // Parsed commands omit absent keys, so each is looked up on its own.
  if (cmd === null) return {};
  return {
    then: "then" in cmd ? cmd.then : undefined,
    until: "until" in cmd ? cmd.until : undefined,
    timeoutMs: "timeoutMs" in cmd ? cmd.timeoutMs : undefined,
  };
}

interface Resolved {
  locator: Locator;
  /** Replay-stable identity recorded at resolution time; never a ref. */
  stable: string;
}

interface Point {
  x: number;
  y: number;
}

/** Viewport point the coordinate verbs offset from; `stable` names the `in`. */
interface Origin extends Point {
  stable?: string;
}

/**
 * One page's refs. Scoped per page because concurrent pinned callers each scan
 * their own tab: a single registry would let every els clobber every other
 * caller's refs, and a navigation in one tab would stale refs in all of them.
 */
interface PageRefs {
  generation: number;
  entries: Map<number, RefEntry>;
}

/** What an action's perform step reports back to runAction. */
interface Performed {
  text: string;
  stableTarget?: string;
  /** The command carried a password; runAction redacts it from the log. */
  secret?: boolean;
}

// Adaptive settle (S1): quiet window and default cap.
const QUIET_MS = 50;
const SETTLE_CAP_MS = 1000;
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta"]);
// The page's document was replaced (navigation) under an evaluate.
const CONTEXT_GONE = /Execution context was destroyed|Cannot find context/;
// goto's wording when the page navigated itself away before load.
const REDIRECTED_AWAY = /ERR_ABORTED|interrupted by another navigation|frame was detached/;
// open (R4): the URL must hold this long before the page counts as arrived.
const URL_QUIET_MS = 150;
const URL_SETTLE_CAP_MS = 3000;

function normalizeUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

// A2: what an action changed. New text in a live region is an alert; an open
// <dialog> or a visible aria-modal is a dialog.
const DELTA_SPEC: DeltaSpec = {
  live: '[role="alert"], [role="status"], [aria-live]:not([aria-live="off"])',
  modal: 'dialog[open], [aria-modal="true"]',
  textMax: 200,
};
const DELTA_ALERTS_MAX = 3;

interface DeltaSpec {
  live: string;
  modal: string;
  textMax: number;
}

/** deltaStart's snapshot of the page before the action. */
interface DeltaBefore {
  dialog: boolean;
  live: string[];
}

/** The page after the action, read in settle's last evaluate. */
interface DeltaRead {
  /** Still deltaStart's document, so its observer saw every mutation. */
  same: boolean;
  added: number;
  removed: number;
  dialog: boolean;
  /** Live-region text seen during the action (same document) or present now (new one). */
  alerts: string[];
  focused: string | null;
}

/** In-page state from deltaStart to the read, kept on window.__bxDelta. */
interface DeltaState {
  observer: MutationObserver;
  added: number;
  removed: number;
  seen: Set<string>;
  hosts: Set<Element>;
}

/**
 * In-page, before the action: counts element nodes added and removed, and
 * notes the text of every live region the action touches as it happens, so a
 * toast that comes and goes inside the settle is still reported.
 */
function deltaStart(spec: DeltaSpec): DeltaBefore {
  const prior: unknown = Reflect.get(window, "__bxDelta");
  if (typeof prior === "object" && prior !== null && "observer" in prior && prior.observer instanceof MutationObserver) {
    prior.observer.disconnect();
  }
  const text = (el: Element): string =>
    el instanceof HTMLElement && el.checkVisibility() ? el.innerText.trim().replace(/\s+/g, " ").slice(0, spec.textMax) : "";
  const size = (n: Node): number => (n instanceof Element ? 1 + n.getElementsByTagName("*").length : 0);
  const seen = new Set<string>();
  const hosts = new Set<Element>();
  let added = 0;
  let removed = 0;
  const observer = new MutationObserver((records) => {
    const touched = new Set<Element>();
    for (const r of records) {
      for (const n of r.addedNodes) {
        added += size(n);
        if (!(n instanceof Element)) continue;
        if (n.matches(spec.live)) touched.add(n);
        for (const h of n.querySelectorAll(spec.live)) touched.add(h);
      }
      for (const n of r.removedNodes) removed += size(n);
      const host = (r.target instanceof Element ? r.target : r.target.parentElement)?.closest(spec.live);
      if (host) touched.add(host);
    }
    for (const h of touched) {
      hosts.add(h);
      const t = text(h);
      if (t) seen.add(t);
    }
    state.added = added;
    state.removed = removed;
  });
  const state: DeltaState = { observer, added, removed, seen, hosts };
  observer.observe(document.documentElement ?? document, { subtree: true, childList: true, characterData: true });
  Object.defineProperty(window, "__bxDelta", { value: state, configurable: true, enumerable: false, writable: true });
  // Nothing reads it after a minute; don't leave it observing forever.
  setTimeout(() => observer.disconnect(), 60_000);
  return {
    dialog: Array.from(document.querySelectorAll(spec.modal)).some((el) => el.checkVisibility()),
    live: Array.from(document.querySelectorAll(spec.live), text).filter((t) => t.length > 0),
  };
}

/**
 * In-page: resolves once no DOM mutation has happened for `quietMs`. Only
 * attributes that change what a user sees or can do count: an animation
 * rewriting `style` every frame would otherwise hold every action to the cap.
 * With `delta`, the result also carries what the action changed (A2), so the
 * after-read costs no extra evaluate.
 */
function domQuiet(o: {
  quietMs: number;
  capMs: number;
  delta: DeltaSpec | null;
}): Promise<{ quiet: boolean; title: string; read: DeltaRead | null }> {
  const readDelta = (spec: DeltaSpec): DeltaRead => {
    const text = (el: Element): string =>
      el instanceof HTMLElement && el.checkVisibility() ? el.innerText.trim().replace(/\s+/g, " ").slice(0, spec.textMax) : "";
    const isState = (v: unknown): v is DeltaState =>
      typeof v === "object" && v !== null && "observer" in v && v.observer instanceof MutationObserver;
    const state: unknown = Reflect.get(window, "__bxDelta");
    const alerts: string[] = [];
    if (isState(state)) {
      // Final text first ("Saved"), then what showed on the way ("Saving…").
      for (const h of state.hosts) if (h.isConnected) alerts.push(text(h));
      alerts.push(...state.seen);
    } else {
      for (const h of document.querySelectorAll(spec.live)) alerts.push(text(h));
    }
    return {
      same: isState(state),
      added: isState(state) ? state.added : 0,
      removed: isState(state) ? state.removed : 0,
      dialog: Array.from(document.querySelectorAll(spec.modal)).some((el) => el.checkVisibility()),
      alerts: alerts.filter((t) => t.length > 0),
      focused: focusedName(),
    };
  };
  // `role "name"` of the focused element; null when nothing is (body).
  const focusedName = (): string | null => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return null;
    const inputRoles: Record<string, string> = {
      checkbox: "checkbox",
      radio: "radio",
      button: "button",
      submit: "button",
      reset: "button",
      image: "button",
      range: "slider",
      search: "searchbox",
      number: "spinbutton",
    };
    const tag = el.tagName.toLowerCase();
    const implicit =
      el instanceof HTMLInputElement
        ? (inputRoles[el.type] ?? "textbox")
        : tag === "textarea"
          ? "textbox"
          : tag === "select"
            ? "combobox"
            : tag === "a" && el.hasAttribute("href")
              ? "link"
              : tag;
    const role = el.getAttribute("role") || implicit;
    const labelledBy = (el.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .map((id) => (id ? (document.getElementById(id)?.textContent ?? "") : ""))
      .join(" ");
    const labels =
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLButtonElement
        ? Array.from(el.labels ?? [], (l) => l.textContent ?? "").join(" ")
        : "";
    const own = el instanceof HTMLElement && !(el instanceof HTMLInputElement) && tag !== "textarea" ? el.innerText : "";
    const name =
      [el.getAttribute("aria-label"), labelledBy, labels, el.getAttribute("placeholder"), el.getAttribute("title"), own]
        .map((s) => (s ?? "").trim().replace(/\s+/g, " "))
        .find((s) => s.length > 0) ?? "";
    return name ? `${role} "${name.slice(0, 60)}"` : role;
  };
  return new Promise((resolve) => {
    const root = document.documentElement ?? document;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (quiet: boolean): void => {
      observer.disconnect();
      clearTimeout(timer);
      clearTimeout(cap);
      resolve({ quiet, title: document.title, read: o.delta ? readDelta(o.delta) : null });
    };
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(finish, o.quietMs, true);
    });
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributeFilter: [
        "class",
        "hidden",
        "open",
        "disabled",
        "aria-expanded",
        "aria-hidden",
        "aria-selected",
        "aria-checked",
        "aria-pressed",
        "aria-busy",
        "aria-disabled",
        "aria-modal",
      ],
    });
    timer = setTimeout(finish, o.quietMs, true);
    const cap = setTimeout(finish, o.capMs, false);
  });
}

type SelectKind =
  | { kind: "native"; options: { value: string; label: string }[] }
  | { kind: "listbox" }
  | { kind: "other" };

/** In-page: what `select` is dealing with, and a native select's options. */
function selectKind(el: Element): SelectKind {
  if (el instanceof HTMLSelectElement) {
    return {
      kind: "native",
      options: Array.from(el.options, (o) => ({ value: o.value, label: (o.label || o.text).trim() })),
    };
  }
  const role = el.getAttribute("role");
  if (role === "combobox" || role === "listbox") return { kind: "listbox" };
  if (el.tagName === "BUTTON" && el.getAttribute("aria-haspopup") === "listbox") return { kind: "listbox" };
  return { kind: "other" };
}

/**
 * In-page: marks the visible role=option named `want` (exact, then
 * case-insensitive) with a data-bx-option nonce; also returns the visible
 * option labels for the miss message.
 */
function markOption(want: string): { marker: string | null; labels: string[] } {
  const visible = Array.from(document.querySelectorAll('[role="option"]')).filter((el) => el.checkVisibility());
  const named = visible.map((el) => ({
    el,
    name: (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " "),
  }));
  const lower = want.trim().toLowerCase();
  const hit = named.find((o) => o.name === want) ?? named.find((o) => o.name.toLowerCase() === lower);
  const labels = named.map((o) => o.name);
  if (!hit) return { marker: null, labels };
  const marker = String(Date.now()) + String(Math.random()).slice(2, 8);
  hit.el.setAttribute("data-bx-option", marker);
  return { marker, labels };
}

function noOption(want: string, stable: string, labels: string[]): { code: "target_not_found"; message: string } {
  const listed = labels.slice(0, 10).map((l) => `"${l}"`).join(", ");
  const more = labels.length > 10 ? ` and ${labels.length - 10} more` : "";
  return {
    code: "target_not_found",
    message: labels.length
      ? `no option "${want}" in "${stable}"; options: ${listed}${more}`
      : `no option "${want}" in "${stable}"; it shows no options`,
  };
}

/**
 * In-page (C6, text --md): the rendered text under `root` as compact markdown:
 * `#` headings, `- ` list items, `[text](href)` links, a blank line between
 * blocks, everything else inline. Hidden subtrees are skipped; the walk stops
 * once `max` characters are out.
 */
function toMarkdown(root: Element, max: number): { text: string; truncated: boolean } {
  const SKIP = new Set(["script", "style", "noscript", "template", "svg", "canvas", "iframe", "head", "select", "option"]);
  const BLOCK = new Set([
    "address", "article", "aside", "blockquote", "body", "dd", "details", "dialog", "div", "dl", "dt", "fieldset",
    "figcaption", "figure", "footer", "form", "header", "hr", "main", "nav", "ol", "p", "section", "summary",
    "table", "tbody", "thead", "tfoot", "tr", "ul", "br",
  ]);
  // Inline controls whose text would otherwise run into the next word.
  const SPACED = new Set(["button", "label", "td", "th", "img", "input"]);
  const blocks: string[] = [];
  let size = 0;
  let line = "";
  let inLink = false;
  const flush = (): void => {
    // A list item keeps its nesting indent; a table row drops its last " | ".
    const indent = /^( *)- /.exec(line)?.[1] ?? "";
    const t = line.replace(/\s+/g, " ").trim().replace(/\s*\|$/, "");
    line = "";
    if (t.length === 0 || /^(#+|-)$/.test(t)) return;
    blocks.push(indent + t);
    size += indent.length + t.length + 2;
  };
  const hrefOf = (a: HTMLAnchorElement): string | null => {
    const raw = a.getAttribute("href") ?? "";
    if (raw === "" || raw.startsWith("javascript:")) return null;
    try {
      const url = new URL(a.href);
      return url.origin === location.origin ? `${url.pathname}${url.search}${url.hash}` : url.href;
    } catch {
      return raw;
    }
  };
  const walk = (node: Node, depth: number): void => {
    if (size > max) return;
    if (node.nodeType === Node.TEXT_NODE) {
      line += node.textContent ?? "";
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const tag = node.tagName.toLowerCase();
    if (SKIP.has(tag)) return;
    // display: contents has no box of its own, but its children render.
    if (!node.checkVisibility() && getComputedStyle(node).display !== "contents") return;
    const role = node.getAttribute("role");
    const heading = /^h[1-6]$/.test(tag) ? Number(tag.slice(1)) : role === "heading" ? Number(node.getAttribute("aria-level") ?? "2") || 2 : 0;
    const kids = (d: number): void => {
      for (const child of node.childNodes) walk(child, d);
    };
    if (inLink) {
      kids(depth);
      line += " ";
      return;
    }
    if (tag === "a" && node instanceof HTMLAnchorElement && hrefOf(node) !== null) {
      const start = line.length;
      inLink = true;
      kids(depth);
      inLink = false;
      const inner = line.slice(start).replace(/\s+/g, " ").trim();
      line = line.slice(0, start) + (inner ? ` [${inner}](${hrefOf(node)}) ` : " ");
      return;
    }
    if (heading > 0) {
      flush();
      line = `${"#".repeat(Math.min(6, heading))} `;
      kids(depth);
      flush();
      return;
    }
    if (tag === "li" || role === "listitem") {
      flush();
      line = `${"  ".repeat(depth)}- `;
      kids(depth + 1);
      flush();
      return;
    }
    if (tag === "pre") {
      flush();
      const code = `\`\`\`\n${node.innerText.replace(/\n+$/, "")}\n\`\`\``;
      blocks.push(code);
      size += code.length + 2;
      return;
    }
    if (BLOCK.has(tag)) {
      flush();
      kids(depth);
      flush();
      return;
    }
    if (SPACED.has(tag)) line += " ";
    if (tag === "img") line += node.getAttribute("alt") ?? "";
    kids(depth);
    if (SPACED.has(tag)) line += tag === "td" || tag === "th" ? " | " : " ";
  };
  walk(root, 0);
  flush();
  // List items sit one per line; any other boundary is a blank line.
  let text = "";
  blocks.forEach((b, i) => {
    const prev = blocks[i - 1];
    const tight = prev !== undefined && /^\s*- /.test(prev) && /^\s*- /.test(b);
    text += i === 0 ? b : tight ? `\n${b}` : `\n\n${b}`;
  });
  const truncated = text.length > max;
  return { text: truncated ? text.slice(0, max) : text, truncated };
}

// wait --idle: how long the network and DOM must both stay quiet.
const IDLE_MS = 500;
// Requests that stay open by design never count against idle.
const LONG_LIVED = new Set(["eventsource", "websocket"]);

/** Every request a page has in flight (wait --idle), kept from track(). */
interface PageNet {
  open: Set<Request>;
  /** Date.now() of the last start or finish. */
  lastChange: number;
}

function waitTimeout(what: string, timeout: number): { code: "timeout"; message: string } {
  return { code: "timeout", message: `${what} within ${timeout} ms` };
}

/** A resolution miss: the target isn't on the page (or its ref went stale). */
function isMiss(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("code" in err)) return false;
  return err.code === "target_not_found" || err.code === "stale_ref";
}

/** Pixel size of a PNG or JPEG, read from its header. */
function imageSize(buf: Buffer): { width: number; height: number } {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG: walk the segments to the frame header (SOF0..SOF15 bar DHT/JPG/DAC).
  let i = 2;
  while (i + 9 < buf.length && buf[i] === 0xff) {
    const marker = buf[i + 1] ?? 0;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return { width: 0, height: 0 };
}

/** fetch/XHR requests a page starts while an action runs. */
interface RequestWatch {
  inFlight(): number;
  /** Date.now() of the last start or finish; 0 when nothing happened. */
  lastChange(): number;
  /** Resolves when nothing is in flight, or after `ms`. */
  drained(ms: number): Promise<void>;
  stop(): void;
}

function watchRequests(page: Page): RequestWatch {
  const open = new Set<Request>();
  let lastChange = 0;
  let wake: (() => void) | null = null;
  const onRequest = (r: Request): void => {
    const type = r.resourceType();
    if (type !== "fetch" && type !== "xhr") return;
    open.add(r);
    lastChange = Date.now();
  };
  const onDone = (r: Request): void => {
    if (!open.delete(r)) return;
    lastChange = Date.now();
    if (open.size === 0 && wake) wake();
  };
  page.on("request", onRequest);
  page.on("requestfinished", onDone);
  page.on("requestfailed", onDone);
  return {
    inFlight: () => open.size,
    lastChange: () => lastChange,
    drained: (ms) =>
      open.size === 0
        ? Promise.resolve()
        : new Promise((resolve) => {
            const timer = setTimeout(done, ms);
            function done(): void {
              clearTimeout(timer);
              wake = null;
              resolve();
            }
            wake = done;
          }),
    stop: () => {
      page.off("request", onRequest);
      page.off("requestfinished", onDone);
      page.off("requestfailed", onDone);
    },
  };
}
// What fill can type into (C4): text-like inputs, textareas, contenteditable.
const FILLABLE = [
  `input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button])` +
    `:not([type=image]):not([type=reset]):not([type=file]):not([type=range]):not([type=color])`,
  "textarea",
  '[contenteditable=""]',
  '[contenteditable="true"]',
].join(", ");
// synthesize.ts matches this mark to emit a placeholder for redacted fills.
const REDACTED_MARK = "•••";
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const OPAQUE_SCHEME = /^(about|data|file|chrome|blob):/i;

function isSelectorish(value: string): boolean {
  return (
    /^[#.[]/.test(value) ||
    value.startsWith("//") ||
    value.startsWith("css=") ||
    value.startsWith("xpath=")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export interface SessionOptions {
  profile: string;
  headless: boolean;
}

/** Context options that only recording varies; see `Session.relaunch`. */
export interface RelaunchOptions {
  recordVideo?: { dir: string; size: { width: number; height: number } };
}

/**
 * What the command in flight is doing, per request (R3). The daemon names the
 * last label when a command outruns its deadline.
 */
export const steps = new AsyncLocalStorage<{ label: string }>();

function step(label: string): void {
  const current = steps.getStore();
  if (current) current.label = label;
}

// Playwright's wording when the page, context or whole browser is gone.
const CLOSED_ERROR = /Target page, context or browser has been closed|Browser has been closed/;
// Chrome's refusal when another process still holds the profile.
const PROFILE_IN_USE = /Opening in existing browser session|ProcessSingleton|profile (is )?(already )?in use/i;

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) return String(err.message);
  return String(err);
}

export class Session {
  readonly profile: string;
  readonly headless: boolean;
  private readonly profileDir: string;
  private readonly snapsDir: string;
  private context: BrowserContext | null = null;
  /** In-flight launch, shared so concurrent commands start one browser. */
  private launching: Promise<BrowserContext> | null = null;
  /** The browser closed under us (crash, window closed, process killed). */
  private dead = false;
  /** Self-heal relaunches since daemon start; the daemon diffs it per command. */
  relaunches = 0;
  /** Tab ids below this belonged to a browser that died. */
  private lostBelow = 0;
  /**
   * Where unpinned commands go, held by identity (O2): opening or closing
   * other tabs never shifts it. A new page takes it only when the active page
   * opened it (see onNewPage); null means "fall back to the newest page".
   */
  private active: Page | null = null;
  private readonly openers = new WeakMap<Page, Page>();
  /** onNewPage's opener check per page; an action awaits it before reporting newTab. */
  private readonly activation = new WeakMap<Page, Promise<void>>();
  private nextPageId = 1;
  private readonly pageIds = new WeakMap<Page, number>();
  private readonly refs = new Map<number, PageRefs>();
  /** Per-page title (S6): navigation events and settle() keep it current. */
  private readonly titles = new Map<number, string>();
  /** Capped; record.ts holds it during a recording (see actionLog.ts). */
  readonly actions = new ActionLog();
  private readonly buffers: Buffers;
  private readonly startedAt = Date.now();
  /** Opened on the first /debug read of a page, never by ordinary commands. */
  private readonly metricSessions = new WeakMap<Page, Promise<CDPSession>>();
  /** In-flight requests per page, for wait --idle. */
  private readonly pageNet = new WeakMap<Page, PageNet>();
  /** Snapshot capture sessions (S4), separate from /debug's metric sessions. */
  private readonly snapSessions = new WeakMap<Page, Promise<CDPSession>>();

  constructor(opts: SessionOptions) {
    this.profile = opts.profile;
    this.headless = opts.headless;
    const bx = path.join(os.homedir(), BX_DIR_NAME);
    this.profileDir = path.join(bx, PROFILES_DIR, opts.profile);
    this.snapsDir = path.join(bx, SNAPS_DIR);
    this.buffers = createBuffers();
  }

  get browserRunning(): boolean {
    return this.context !== null && !this.dead;
  }

  /** The active page's tab id without touching the page (log lines). */
  get activeTabId(): number | undefined {
    const page = this.activePage();
    return page ? this.pageId(page) : undefined;
  }

  /** The active page, re-picked (newest page) when it closed or never was. */
  private activePage(): Page | undefined {
    const pages = this.context?.pages() ?? [];
    if (this.active && !this.active.isClosed() && pages.includes(this.active)) return this.active;
    const fallback = pages[pages.length - 1];
    this.active = fallback ?? null;
    return fallback;
  }

  // -------------------------------------------------------------------------
  // Browser lifecycle
  // -------------------------------------------------------------------------

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    step(this.dead ? "relaunch browser" : "launch browser");
    if (!this.launching) {
      this.launching = (this.dead ? this.relaunchDead() : this.boot()).finally(() => {
        this.launching = null;
      });
    }
    return this.launching;
  }

  private async boot(): Promise<BrowserContext> {
    try {
      return await this.launch();
    } catch (err) {
      throw {
        code: "browser_launch_failed",
        message: `${errorMessage(err)} — is another bx daemon using profile "${this.profile}"?`,
      };
    }
  }

  /**
   * Self-heal: the same path as boot, one blank page, nothing restored. Pages
   * and refs of the dead browser are gone; its pinned tab ids report as lost.
   */
  private async relaunchDead(): Promise<BrowserContext> {
    const lostBelow = this.nextPageId;
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const context = await this.launch();
        if (context.pages().length === 0) await context.newPage();
        this.dead = false;
        this.lostBelow = lostBelow;
        this.active = null;
        this.refs.clear();
        this.relaunches++;
        console.log(`[${new Date().toISOString()}] browser relaunched after it closed (${this.relaunches} so far)`);
        return context;
      } catch (err) {
        lastError = errorMessage(err);
      }
    }
    throw { code: "browser_dead", message: `the browser closed and relaunching it failed twice: ${lastError}` };
  }

  /**
   * The one launch path: boot, self-heal and recording all come through here.
   * Seeds the OS-password check first, retries once after clearing stale
   * profile locks, and wires page tracking plus death detection.
   */
  private async launch(extra?: RelaunchOptions): Promise<BrowserContext> {
    const { chromium } = await import("playwright-core");
    // Must precede every launch: a cold profile makes Chrome probe the Windows
    // password with a failed logon, and enough of those lock the account.
    console.log(`[${new Date().toISOString()}] ${seedOsPasswordCheck(this.profileDir)}`);
    const options = {
      channel: "chrome",
      headless: this.headless,
      viewport: { width: 1280, height: 800 },
      // 64 MB: an uncapped disk cache is most of a profile's ~84 MB.
      args: ["--disk-cache-size=67108864"],
      ...extra,
    };
    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(this.profileDir, options);
    } catch (err) {
      if (!PROFILE_IN_USE.test(errorMessage(err))) throw err;
      // A dead daemon's Chrome still holds the profile: kill it, drop the locks, retry once.
      const cleared = await clearProfileLocks(this.profileDir, { selfPid: process.pid });
      console.log(`[${new Date().toISOString()}] ${describeClear(this.profileDir, cleared)}`);
      if (!cleared.cleared) throw err;
      context = await chromium.launchPersistentContext(this.profileDir, options);
    }
    this.context = context;
    for (const page of context.pages()) this.track(page);
    context.on("page", (page) => this.onNewPage(page));
    // Deliberate closes (recording relaunch, shutdown) drop this.context
    // first, so only an unexpected close gets past the check.
    context.on("close", () => {
      if (this.context === context) this.markDead("browser context closed");
    });
    return context;
  }

  private markDead(why: string): void {
    if (this.dead) return;
    this.dead = true;
    this.context = null;
    console.log(`[${new Date().toISOString()}] browser is dead (${why}); the next command relaunches it`);
  }

  /**
   * A command failed with Playwright's "closed" wording. That wording also
   * covers a single closed page, so probe the context before declaring the
   * browser dead: relaunching would take every other tab down with it.
   */
  async noteFailure(err: unknown): Promise<void> {
    const context = this.context;
    if (!context || this.dead || !CLOSED_ERROR.test(errorMessage(err))) return;
    const alive = await Promise.race([
      context.cookies().then(
        () => true,
        () => false,
      ),
      sleep(1000).then(() => true),
    ]);
    if (!alive && this.context === context) this.markDead("a command found it closed");
  }

  /**
   * A popup or tab the active page opened becomes active, as it would for a
   * person clicking. Anything else stays in the background: a tab opened by a
   * command pinned to another tab, a `tabNew --background`, or a noopener
   * link (no opener to check). Actions report new tabs either way.
   */
  private onNewPage(page: Page): void {
    this.track(page);
    // Read before activePage() could fall back to this very page.
    const activeNow = this.active && !this.active.isClosed() ? this.active : null;
    const settled = page.opener().then(
      (opener) => {
        if (!opener) return;
        this.openers.set(page, opener);
        if (opener === activeNow && this.active === activeNow && !page.isClosed()) this.active = page;
      },
      () => undefined,
    );
    this.activation.set(page, settled);
  }

  private track(page: Page): void {
    const id = this.pageId(page);
    attachObservers(page, this.buffers, id);
    const net: PageNet = { open: new Set<Request>(), lastChange: Date.now() };
    this.pageNet.set(page, net);
    page.on("request", (r) => {
      if (LONG_LIVED.has(r.resourceType())) return;
      net.open.add(r);
      net.lastChange = Date.now();
    });
    const done = (r: Request): void => {
      if (net.open.delete(r)) net.lastChange = Date.now();
    };
    page.on("requestfinished", done);
    page.on("requestfailed", done);
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) this.refreshTitle(page);
    });
    page.on("domcontentloaded", () => this.refreshTitle(page));
    page.on("close", () => {
      this.refs.delete(id);
      this.titles.delete(id);
      // A closed popup hands the active slot back to the page that opened it.
      if (this.active === page) {
        const opener = this.openers.get(page);
        this.active = opener && !opener.isClosed() ? opener : null;
      }
    });
  }

  private async ensurePage(): Promise<Page> {
    const context = await this.ensureContext();
    if (context.pages().length === 0) await context.newPage();
    const page = this.activePage();
    if (!page) throw { code: "no_page", message: "no page available" };
    return page;
  }

  /**
   * Routing for every command that accepts a `tab` pin: pinned commands act on
   * their own page no matter which tab is active, so concurrent callers cannot
   * pull the page out from under each other.
   */
  private async pageFor(tab?: number): Promise<Page> {
    if (tab === undefined) return this.ensurePage();
    const context = await this.ensureContext();
    const page = context.pages().find((p) => this.pageIds.get(p) === tab);
    if (!page) {
      if (tab < this.lostBelow) {
        throw { code: "no_page", message: `tab ${tab} was lost when the browser closed; open a new one` };
      }
      throw { code: "no_page", message: `tab ${tab} is closed` };
    }
    return page;
  }

  async close(): Promise<void> {
    const context = this.context;
    this.context = null;
    if (context) await context.close().catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Page/ref bookkeeping
  // -------------------------------------------------------------------------

  /** Stable id for pinning; ids are never reused within a session. */
  private pageId(page: Page): number {
    const known = this.pageIds.get(page);
    if (known !== undefined) return known;
    const id = this.nextPageId++;
    this.pageIds.set(page, id);
    return id;
  }

  private refsFor(page: Page): PageRefs {
    const id = this.pageId(page);
    const known = this.refs.get(id);
    if (known) return known;
    const fresh: PageRefs = { generation: 0, entries: new Map<number, RefEntry>() };
    this.refs.set(id, fresh);
    return fresh;
  }

  /**
   * Title cache upkeep. Fire-and-forget: on a page stuck in a busy loop the
   * read never answers, and nothing may wait on it.
   */
  private refreshTitle(page: Page): void {
    const id = this.pageId(page);
    page.title().then(
      (title) => {
        if (!page.isClosed()) this.titles.set(id, title);
      },
      () => undefined,
    );
  }

  /** Pure bookkeeping: the title comes from the cache, never from the page. */
  private pageInfo(page: Page): PageInfo {
    const pages = this.context?.pages() ?? [];
    const index = pages.indexOf(page);
    const id = this.pageId(page);
    return {
      index: index < 0 ? 0 : index,
      id,
      url: page.url(),
      title: this.titles.get(id) ?? "",
      active: page === this.activePage(),
    };
  }

  /** Fresh scan; bumps this page's generation and rebuilds its ref registry. */
  private async scan(page: Page): Promise<DistillResult> {
    const result = await distillPage(page);
    this.refsFor(page).generation++;
    this.register(page, result);
    return result;
  }

  private register(page: Page, result: DistillResult): void {
    const refs = this.refsFor(page);
    refs.entries.clear();
    for (const entry of result.refEntries) {
      refs.entries.set(entry.ref, { ...entry, generation: refs.generation });
    }
  }

  private appendAction(cmd: Cmd, text: string, stableTarget?: string, tab?: number): void {
    const machine: Record<string, unknown> = { ...cmd };
    // Pinning is a concurrency device; synthesized flows replay single-tab.
    delete machine.tab;
    const target = machine.target;
    // Refs are session-local; flows must replay in a fresh session.
    if (stableTarget && typeof target === "object" && target !== null && "ref" in target) {
      machine.target = { text: stableTarget };
    }
    this.actions.push({
      t: Date.now() - this.buffers.t0,
      cmd: cmd.cmd,
      text,
      cmdJson: JSON.stringify(machine),
      stableTarget,
      tab,
    });
  }

  /**
   * Common envelope for state-changing commands: console mark + url before,
   * settle + diff after. `cmd` null means "do not write to the action log".
   * `settleCap` is the most settle() may wait; 0 skips it.
   */
  private async runAction(
    cmd: Cmd | null,
    tab: number | undefined,
    perform: (page: Page) => Promise<Performed>,
    settleCap = SETTLE_CAP_MS,
  ): Promise<ActionResult> {
    const page = await this.pageFor(tab);
    const id = this.pageId(page);
    const urlBefore = page.url();
    const titleBefore = this.titles.get(id) ?? "";
    const mark = markConsole(this.buffers.console);
    // Counted from before the action: only requests it caused hold the settle.
    const requests = watchRequests(page);
    // A2: an action that settles reports what it changed. The before-snapshot
    // is the one extra evaluate; the after-read rides on settle's last one.
    const spec = settleCap > 0 ? DELTA_SPEC : null;
    const before = spec ? await page.evaluate(deltaStart, spec).catch(() => null) : null;
    const created: Page[] = [];
    const onPage = (p: Page): void => {
      created.push(p);
    };
    const context = page.context();
    context.on("page", onPage);
    let settledMs = 0;
    let read: DeltaRead | null = null;
    let performed: Performed;
    try {
      performed = await perform(page);
      if (settleCap > 0) ({ ms: settledMs, read } = await this.settle(page, settleCap, requests, spec));
    } finally {
      requests.stop();
      context.off("page", onPage);
    }
    const { text, stableTarget, secret } = performed;
    // The log outlives the command: a password must not reach cmdJson.
    if (cmd) {
      const logged = secret === true && cmd.cmd === "fill" ? { ...cmd, value: REDACTED_MARK } : cmd;
      this.appendAction(logged, text, stableTarget, id);
    }
    const extras = actionExtras(cmd);
    if (cmd && extras.until !== undefined) {
      // The action already ran (and is logged); this only decides the outcome.
      const until = extras.until;
      step(`wait for "${until}"`);
      await page
        .getByText(until)
        .first()
        .waitFor({ state: "visible", timeout: extras.timeoutMs ?? BUDGET.DEFAULT_TIMEOUT_MS })
        .catch(() => {
          throw { code: "timeout", message: `"${until}" never appeared after ${cmd.cmd}` };
        });
      if (spec) read = (await this.readDelta(page, spec)) ?? read;
    }
    const navigated = urlBefore !== page.url();
    if (navigated) this.refsFor(page).generation++;
    const result: ActionResult = {
      page: this.pageInfo(page),
      navigated,
      consoleErrors: newErrorsSince(this.buffers.console, mark, id).slice(0, 5),
      settledMs,
    };
    if (spec) result.delta = await this.delta(page, { urlBefore, titleBefore, before, read, created });
    if (extras.then !== undefined) result.then = await this.observeAfter(page, extras.then);
    return result;
  }

  /** ActionDelta from the before-snapshot, the after-read and the pages the action opened. */
  private async delta(
    page: Page,
    o: { urlBefore: string; titleBefore: string; before: DeltaBefore | null; read: DeltaRead | null; created: Page[] },
  ): Promise<ActionDelta> {
    const { before, read } = o;
    // A replaced document has no counts: its observer went with the old one.
    const delta: ActionDelta = { added: read?.same ? read.added : 0, removed: read?.same ? read.removed : 0 };
    const url = page.url();
    if (url !== o.urlBefore) delta.url = url;
    const title = this.titles.get(this.pageId(page)) ?? "";
    if (title !== o.titleBefore) delta.title = title;
    if (read) {
      if (read.dialog !== (before?.dialog ?? false)) delta.dialog = read.dialog ? "opened" : "closed";
      const old = new Set(before?.live ?? []);
      const alerts = [...new Set(read.alerts)].filter((t) => !old.has(t)).slice(0, DELTA_ALERTS_MAX);
      if (alerts.length > 0) delta.alerts = alerts;
      if (read.focused !== null) delta.focused = read.focused;
    }
    for (const opened of o.created) {
      if (opened.isClosed()) continue;
      // Settles whether O2 made it active, so PageInfo.active is right.
      await this.activation.get(opened);
      const opener = await opened.opener().catch(() => null);
      // A noopener tab has no opener; any tab opened by another page is not ours.
      if (opener !== null && opener !== page) continue;
      delta.newTab = this.pageInfo(opened);
      break;
    }
    return delta;
  }

  /** The after-read alone, for when settle's last evaluate is stale. */
  private async readDelta(page: Page, spec: DeltaSpec): Promise<DeltaRead | null> {
    try {
      return (await page.evaluate(domQuiet, { quietMs: 0, capMs: 0, delta: spec })).read;
    } catch {
      return null;
    }
  }

  /** An action's `then`: one observation of the settled page, in the same result. */
  private async observeAfter(page: Page, what: ActionThen): Promise<NonNullable<ActionResult["then"]>> {
    if (what === "els") {
      step("scan");
      const scan = await this.scan(page);
      return { els: { generation: this.refsFor(page).generation, ...renderEls(scan, {}) } };
    }
    if (what === "text") return { text: await this.readText(page, {}) };
    return { snap: await this.capture(page, {}) };
  }

  /**
   * Waits until the DOM has been quiet for QUIET_MS and none of the action's
   * fetch/XHR requests is in flight, capped at `capMs`. Returns the time
   * spent, and with `delta` the after-read of the last evaluate (re-read when
   * a wait followed it). A navigation mid-wait restarts the DOM check on the
   * new document.
   */
  private async settle(
    page: Page,
    capMs: number,
    requests: RequestWatch,
    delta: DeltaSpec | null,
  ): Promise<{ ms: number; read: DeltaRead | null }> {
    step("settle");
    const started = Date.now();
    const left = (): number => capMs - (Date.now() - started);
    let read: DeltaRead | null = null;
    let fresh = false;
    while (left() > 0) {
      let quiet: boolean;
      try {
        const r = await page.evaluate(domQuiet, { quietMs: QUIET_MS, capMs: left(), delta });
        this.titles.set(this.pageId(page), r.title);
        quiet = r.quiet;
        read = r.read;
        fresh = true;
      } catch (err) {
        fresh = false;
        if (page.isClosed() || !CONTEXT_GONE.test(errorMessage(err))) break;
        await page.waitForLoadState("domcontentloaded", { timeout: Math.max(1, left()) }).catch(() => undefined);
        continue;
      }
      if (!quiet) break;
      if (requests.inFlight() > 0) {
        fresh = false;
        await requests.drained(left());
        continue;
      }
      // A request that just finished may still be rendering its result.
      if (Date.now() - requests.lastChange() < QUIET_MS) {
        fresh = false;
        continue;
      }
      break;
    }
    const ms = Math.min(capMs, Date.now() - started);
    if (delta && !fresh && !page.isClosed()) read = (await this.readDelta(page, delta)) ?? read;
    return { ms, read };
  }

  /** Explicit `settle` wins; otherwise `skip` actions don't settle at all. */
  private settleCap(requested: number | undefined, skip = false): number {
    if (requested !== undefined) return requested;
    return skip ? 0 : SETTLE_CAP_MS;
  }

  // -------------------------------------------------------------------------
  // Target resolution
  // -------------------------------------------------------------------------

  private async firstPresent(candidates: Locator[]): Promise<Locator | null> {
    for (const candidate of candidates) {
      const count = await candidate.count().catch(() => 0);
      if (count > 0) return candidate.first();
    }
    return null;
  }

  private async resolveTarget(page: Page, target: Target): Promise<Resolved> {
    step("resolve target");
    if ("ref" in target) {
      const refs = this.refsFor(page);
      const entry = refs.entries.get(target.ref);
      if (!entry) {
        throw { code: "target_not_found", message: `ref ${target.ref} is unknown — run bx els` };
      }
      if (entry.generation !== refs.generation) {
        throw { code: "stale_ref", message: `ref ${target.ref} is stale — re-run bx els` };
      }
      const candidates: Locator[] = [];
      if (entry.testid) candidates.push(page.getByTestId(entry.testid));
      if (entry.domId) {
        candidates.push(page.locator(`[id="${entry.domId.replaceAll('"', '\\"')}"]`));
      }
      if (entry.role) {
        // Playwright's AriaRole union is not knowable from a distilled string.
        const options = entry.role.name ? { name: entry.role.name, exact: false } : {};
        candidates.push(page.getByRole(entry.role.role as never, options));
      }
      candidates.push(page.locator(entry.cssPath));
      const locator = await this.firstPresent(candidates);
      if (!locator) {
        throw { code: "stale_ref", message: `ref ${target.ref} is stale — re-run bx els` };
      }
      return { locator, stable: entry.testid ?? entry.role?.name ?? entry.cssPath };
    }

    if ("selector" in target) {
      return { locator: page.locator(target.selector).first(), stable: target.selector };
    }
    // Interim until resolve.ts lands (phase 2): plain Playwright lookups.
    if ("testid" in target) return { locator: page.getByTestId(target.testid).first(), stable: target.testid };
    if ("label" in target) return { locator: page.getByLabel(target.label).first(), stable: target.label };
    if ("role" in target) {
      throw { code: "bad_request", message: "role targets need the new resolver (phase 2)" };
    }

    const text = target.text;
    const roles = ["button", "link", "tab", "menuitem", "checkbox", "radio"];
    const candidates: Locator[] = [
      page.getByTestId(text),
      ...roles.map((role) => page.getByRole(role as never, { name: text, exact: false })),
      page.getByLabel(text),
      page.getByPlaceholder(text),
      page.getByText(text, { exact: true }),
      page.getByText(text),
    ];
    const locator = await this.firstPresent(candidates);
    if (!locator) {
      throw {
        code: "target_not_found",
        message: `no element matching "${text}"`,
        nearMatches: await this.nearMatches(page, text),
      };
    }
    return { locator, stable: text };
  }

  /**
   * Where the coordinate verbs measure from. With `in`, x/y are relative to
   * that element's top-left, so a fixed-size canvas keeps one set of
   * coordinates wherever the page puts it; without it, the viewport origin.
   */
  private async resolveOrigin(page: Page, inTarget?: Target): Promise<Origin> {
    if (!inTarget) return { x: 0, y: 0 };
    const { locator, stable } = await this.resolveTarget(page, inTarget);
    const box = await locator.boundingBox();
    if (!box) {
      throw { code: "target_not_found", message: `"${stable}" has no layout box — is it visible?` };
    }
    return { x: box.x, y: box.y, stable };
  }

  /** Re-registers at the current generation so the suggested refs are usable. */
  private async nearMatches(page: Page, text: string): Promise<El[]> {
    const words = text
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0);
    let scan: DistillResult;
    try {
      scan = await distillPage(page);
    } catch {
      return [];
    }
    this.register(page, scan);
    return scan.els
      .filter((el) => {
        const haystack = `${el.name} ${el.testid ?? ""} ${el.id ?? ""}`.toLowerCase();
        return words.some((w) => haystack.includes(w));
      })
      .slice(0, 5);
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  async open(cmd: CmdOf<"open">): Promise<OpenResult> {
    const url =
      HAS_SCHEME.test(cmd.url) || OPAQUE_SCHEME.test(cmd.url) ? cmd.url : `https://${cmd.url}`;
    const page = await this.pageFor(cmd.tab);
    const urlBefore = page.url();
    let interrupted = false;
    try {
      step("navigate");
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    } catch (err) {
      // A page that redirects itself before it parses (auth guards) makes goto
      // report its own navigation as aborted while the redirect carries on.
      // Only a page that went nowhere is a real failure.
      if (!REDIRECTED_AWAY.test(errorMessage(err)) || page.url() === urlBefore) throw err;
      interrupted = true;
    }
    step("wait for redirects");
    await this.urlSettled(page, interrupted);
    let scan: DistillResult;
    try {
      step("scan");
      scan = await this.scan(page);
    } catch (err) {
      // It redirected again after the quiet window; scan the page it landed on.
      if (!CONTEXT_GONE.test(errorMessage(err))) throw err;
      step("wait for redirects");
      await this.urlSettled(page, true);
      step("scan");
      scan = await this.scan(page);
    }
    this.appendAction({ cmd: "open", url }, `opened ${url}`, url, this.pageId(page));
    const finalUrl = page.url();
    const result: OpenResult = {
      page: this.pageInfo(page),
      els: { generation: this.refsFor(page).generation, ...renderEls(scan, {}) },
    };
    if (normalizeUrl(finalUrl) !== normalizeUrl(url)) result.redirectedTo = finalUrl;
    return result;
  }

  /**
   * Client-side redirects land after the document parses: wait until the main
   * frame's URL has held for URL_QUIET_MS (capped). Only when it moved is the
   * final document's `load` worth waiting for (`moved`: it already had, under
   * goto); a page that stayed put is already usable at domcontentloaded.
   */
  private async urlSettled(page: Page, moved = false): Promise<void> {
    const started = Date.now();
    const first = page.url();
    let last = first;
    let since = started;
    while (Date.now() - since < URL_QUIET_MS && Date.now() - started < URL_SETTLE_CAP_MS) {
      await sleep(25);
      const now = page.url();
      if (now !== last) {
        last = now;
        since = Date.now();
      }
    }
    if (moved || last !== first) {
      await page.waitForLoadState("load", { timeout: URL_SETTLE_CAP_MS }).catch(() => undefined);
    }
  }

  async els(cmd: CmdOf<"els">): Promise<ElsResult> {
    const page = await this.pageFor(cmd.tab);
    step("scan");
    const scan = await this.scan(page);
    return {
      generation: this.refsFor(page).generation,
      ...renderEls(scan, { all: cmd.all, filter: cmd.filter }),
    };
  }

  async click(cmd: CmdOf<"click">): Promise<ActionResult> {
    return this.runAction(cmd, cmd.tab, async (page) => {
      const { locator, stable } = await this.resolveTarget(page, cmd.target);
      step("click");
      await locator.click({ timeout: cmd.timeoutMs ?? BUDGET.DEFAULT_TIMEOUT_MS });
      return { text: `clicked "${stable}"`, stableTarget: stable };
    }, this.settleCap(cmd.settle));
  }

  async fill(cmd: CmdOf<"fill">): Promise<ActionResult> {
    return this.runAction(cmd, cmd.tab, async (page) => {
      const timeout = cmd.timeoutMs ?? BUDGET.DEFAULT_TIMEOUT_MS;
      const resolved = await this.resolveTarget(page, cmd.target);
      const { stable } = resolved;
      const { locator, type } = await this.fillableField(page, resolved, timeout);
      step("fill");
      await locator.fill(cmd.value, { timeout });
      const secret = type === "password";
      const shown = secret ? REDACTED_MARK : cmd.value;
      return { text: `filled "${stable}" with "${shown}"`, stableTarget: stable, secret };
    }, this.settleCap(cmd.settle));
  }

  /**
   * The field a fill should type into (C4). Targets often land on a wrapper
   * (a form row, a custom input component) or a label: use the target itself
   * when it takes text, else its single fillable descendant, else the
   * label's control. None or several is a miss that says how many.
   */
  private async fillableField(
    page: Page,
    resolved: Resolved,
    timeout: number,
  ): Promise<{ locator: Locator; type: string | null }> {
    step("find the field");
    const probe = await resolved.locator.evaluate(
      (el, selector) => {
        const typeOf = (e: Element): string | null => e.getAttribute("type");
        if (el.matches(selector)) return { self: true, inside: 0, controlId: null, type: typeOf(el) };
        const inside = el.querySelectorAll(selector);
        const only = inside.length === 1 ? inside[0] : undefined;
        const control = el instanceof HTMLLabelElement ? el.control : null;
        return {
          self: false,
          inside: inside.length,
          controlId: control && control.matches(selector) && control.id ? control.id : null,
          type: only ? typeOf(only) : control ? typeOf(control) : null,
        };
      },
      FILLABLE,
      { timeout },
    );
    if (probe.self) return { locator: resolved.locator, type: probe.type };
    if (probe.inside === 1) return { locator: resolved.locator.locator(FILLABLE).first(), type: probe.type };
    if (probe.inside === 0 && probe.controlId !== null) {
      return { locator: page.locator(`[id="${probe.controlId.replaceAll('"', '\\"')}"]`), type: probe.type };
    }
    throw {
      code: "target_not_found",
      message:
        probe.inside > 1
          ? `"${resolved.stable}" is not a text field and holds ${probe.inside} of them — target one directly`
          : `"${resolved.stable}" is not a text field and holds none`,
    };
  }

  async select(cmd: CmdOf<"select">): Promise<ActionResult> {
    return this.runAction(cmd, cmd.tab, async (page) => {
      const { locator, stable } = await this.resolveTarget(page, cmd.target);
      const timeout = cmd.timeoutMs ?? BUDGET.DEFAULT_TIMEOUT_MS;
      step("read options");
      const kind = await locator.evaluate(selectKind, undefined, { timeout });
      if (kind.kind === "native") {
        const want = cmd.value;
        const match =
          kind.options.find((o) => o.value === want) ??
          kind.options.find((o) => o.label === want) ??
          kind.options.find((o) => o.label.toLowerCase() === want.trim().toLowerCase());
        if (!match) throw noOption(want, stable, kind.options.map((o) => o.label));
        step("select");
        await locator.selectOption({ value: match.value }, { timeout });
      } else if (kind.kind === "listbox") {
        step("open the list");
        await locator.click({ timeout });
        await this.pickOption(page, cmd.value, stable, timeout);
      } else {
        throw { code: "target_not_found", message: `"${stable}" is not a select, combobox or listbox` };
      }
      return { text: `selected "${cmd.value}" in "${stable}"`, stableTarget: stable };
    }, this.settleCap(cmd.settle));
  }

  /**
   * Custom dropdowns (C5): after opening, click the visible role=option whose
   * name matches exactly, else case-insensitively. Options render async, so
   * the list is polled until one matches or the timeout runs out.
   */
  private async pickOption(page: Page, want: string, stable: string, timeout: number): Promise<void> {
    step("pick the option");
    const deadline = Date.now() + timeout;
    let seen: string[] = [];
    for (;;) {
      const found = await page.evaluate(markOption, want);
      seen = found.labels;
      if (found.marker !== null) {
        const option = page.locator(`[data-bx-option="${found.marker}"]`);
        try {
          await option.click({ timeout: Math.max(1000, deadline - Date.now()) });
        } finally {
          await option.evaluate((el) => el.removeAttribute("data-bx-option")).catch(() => undefined);
        }
        return;
      }
      if (Date.now() >= deadline) throw noOption(want, stable, seen);
      await sleep(100);
    }
  }

  async press(cmd: CmdOf<"press">): Promise<ActionResult> {
    return this.runAction(cmd, cmd.tab, async (page) => {
      step("press");
      await page.keyboard.press(cmd.key);
      return { text: `pressed ${cmd.key}` };
    }, this.settleCap(cmd.settle, MODIFIER_KEYS.has(cmd.key)));
  }

  async wait(cmd: CmdOf<"wait">): Promise<ActionResult> {
    const conditions = [cmd.text, cmd.selector, cmd.ms, cmd.idle === true ? true : undefined, cmd.gone, cmd.url, cmd.js];
    if (conditions.filter((v) => v !== undefined).length !== 1) {
      throw {
        code: "bad_request",
        message: "wait takes exactly one of --text, --selector, --ms, --idle, --gone, --url, --js",
      };
    }
    const timeout = cmd.timeoutMs ?? BUDGET.DEFAULT_TIMEOUT_MS;
    // The wait is its own settle: the caller named what to wait for.
    return this.runAction(null, cmd.tab, async (page) => {
      step("wait");
      if (cmd.ms !== undefined) {
        await sleep(Math.min(cmd.ms, 30000));
      } else if (cmd.text !== undefined) {
        const text = cmd.text;
        await page
          .getByText(text)
          .first()
          .waitFor({ state: "visible", timeout })
          .catch(() => {
            throw waitTimeout(`text "${text}" was not visible`, timeout);
          });
      } else if (cmd.selector !== undefined) {
        const selector = cmd.selector;
        await page
          .locator(selector)
          .first()
          .waitFor({ state: "visible", timeout })
          .catch(() => {
            throw waitTimeout(`"${selector}" was not visible`, timeout);
          });
      } else if (cmd.idle === true) {
        await this.waitIdle(page, timeout);
      } else if (cmd.gone !== undefined) {
        await this.waitGone(page, cmd.gone, timeout);
      } else if (cmd.url !== undefined) {
        const want = cmd.url;
        await this.poll(timeout, async () => page.url().includes(want), () => `the URL never contained "${want}" (it is ${page.url()})`);
      } else if (cmd.js !== undefined) {
        const source = `(async () => !!(await ${jsFunctionSource(cmd.js)}()))()`;
        let lastError = "";
        await this.poll(
          timeout,
          async () => {
            try {
              const truthy = await page.evaluate<unknown>(source);
              lastError = "";
              return truthy === true;
            } catch (err) {
              // Mid-navigation the context is gone; anything else is worth reporting.
              const first = (errorMessage(err).split("\n")[0] ?? "").replace(/^page\.evaluate: /, "");
              lastError = CONTEXT_GONE.test(errorMessage(err)) ? "" : first;
              return false;
            }
          },
          () => `${cmd.js} never became truthy${lastError ? ` (last error: ${lastError})` : ""}`,
        );
      }
      return { text: "waited" };
    }, 0);
  }

  /** Polls `check` every 100 ms; `timeout` naming the condition when it never holds. */
  private async poll(timeout: number, check: () => Promise<boolean>, describe: () => string): Promise<void> {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (await check()) return;
      if (Date.now() >= deadline) throw waitTimeout(describe(), timeout);
      await sleep(100);
    }
  }

  /** wait --idle: no request of any kind in flight and the DOM quiet, both for IDLE_MS. */
  private async waitIdle(page: Page, timeout: number): Promise<void> {
    const net = this.pageNet.get(page);
    const deadline = Date.now() + timeout;
    const left = (): number => deadline - Date.now();
    while (left() > 0) {
      if (net && net.open.size > 0) {
        await sleep(Math.min(50, left()));
        continue;
      }
      let quiet = false;
      try {
        quiet = (await page.evaluate(domQuiet, { quietMs: IDLE_MS, capMs: left(), delta: null })).quiet;
      } catch (err) {
        if (!CONTEXT_GONE.test(errorMessage(err))) throw err;
        continue;
      }
      if (quiet && (!net || (net.open.size === 0 && Date.now() - net.lastChange >= IDLE_MS))) return;
    }
    const busy = net ? net.open.size : 0;
    throw waitTimeout(`the page never went idle (${busy} request${busy === 1 ? "" : "s"} in flight)`, timeout);
  }

  /** wait --gone: the target resolves to nothing visible. */
  private async waitGone(page: Page, target: Target, timeout: number): Promise<void> {
    let stable = "";
    await this.poll(
      timeout,
      async () => {
        let resolved: Resolved;
        try {
          resolved = await this.resolveTarget(page, target);
        } catch (err) {
          if (isMiss(err)) return true;
          throw err;
        }
        stable = resolved.stable;
        return !(await resolved.locator.isVisible());
      },
      () => `"${stable}" was still visible`,
    );
  }

  async expect(cmd: CmdOf<"expect">): Promise<ExpectResult> {
    const page = await this.pageFor(cmd.tab);
    step("expect");
    const result = await this.evaluateExpect(page, cmd);
    // Passing assertions are what make a synthesized flow a regression test;
    // failing ones are exploration noise.
    if (result.pass) {
      const kind = cmd.kind === "notVisible" ? "not-visible" : cmd.kind;
      this.appendAction(cmd, `expect ${kind} "${cmd.value}"`, undefined, this.pageId(page));
    }
    return result;
  }

  private async evaluateExpect(page: Page, cmd: CmdOf<"expect">): Promise<ExpectResult> {
    const timeout = cmd.timeoutMs ?? BUDGET.DEFAULT_TIMEOUT_MS;

    if (cmd.kind === "url") {
      const deadline = Date.now() + timeout;
      for (;;) {
        const url = page.url();
        if (url.includes(cmd.value)) return { pass: true, detail: `url is ${url}` };
        if (Date.now() >= deadline) {
          return { pass: false, detail: `url ${url} does not contain "${cmd.value}" within ${timeout}ms` };
        }
        await sleep(100);
      }
    }

    if (cmd.kind === "text") {
      try {
        await page.getByText(cmd.value).first().waitFor({ state: "visible", timeout });
        return { pass: true, detail: `text "${cmd.value}" is visible` };
      } catch {
        return { pass: false, detail: `text not visible within ${timeout}ms` };
      }
    }

    const locator = isSelectorish(cmd.value)
      ? page.locator(cmd.value).first()
      : page.getByText(cmd.value).first();
    const wantVisible = cmd.kind === "visible";
    try {
      await locator.waitFor({ state: wantVisible ? "visible" : "hidden", timeout });
      return {
        pass: true,
        detail: `"${cmd.value}" is ${wantVisible ? "visible" : "not visible"}`,
      };
    } catch {
      return {
        pass: false,
        detail: `"${cmd.value}" was ${wantVisible ? "not visible" : "still visible"} within ${timeout}ms`,
      };
    }
  }

  async snap(cmd: CmdOf<"snap">): Promise<SnapResult> {
    const page = await this.pageFor(cmd.tab);
    return this.capture(page, cmd);
  }

  /**
   * One CDP Page.captureScreenshot (S4): the clip picks the area (viewport,
   * full page or the target's box) and its scale applies the output width
   * rule, so nothing is decoded or re-encoded in the page. `stable` repeats
   * the capture until two in a row are byte-equal.
   */
  private async capture(page: Page, opts: Omit<CmdOf<"snap">, "cmd" | "tab">): Promise<SnapResult> {
    step("measure");
    let cdp = await this.cdpFor(page);
    let metrics;
    try {
      metrics = await cdp.send("Page.getLayoutMetrics");
    } catch {
      // The cached session died (renderer swap, crash); open a fresh one.
      this.snapSessions.delete(page);
      cdp = await this.cdpFor(page);
      metrics = await cdp.send("Page.getLayoutMetrics");
    }
    const view = metrics.cssVisualViewport;
    let clip: { x: number; y: number; width: number; height: number };
    let beyond = false;
    if (opts.target) {
      const { locator, stable } = await this.resolveTarget(page, opts.target);
      const box = await locator.boundingBox({ timeout: BUDGET.DEFAULT_TIMEOUT_MS });
      if (!box || box.width < 1 || box.height < 1) {
        throw { code: "target_not_found", message: `"${stable}" has no layout box — is it visible?` };
      }
      clip = { x: box.x + view.pageX, y: box.y + view.pageY, width: box.width, height: box.height };
      beyond = true;
    } else if (opts.full === true) {
      const size = metrics.cssContentSize;
      clip = { x: 0, y: 0, width: size.width, height: size.height };
      beyond = true;
    } else {
      clip = { x: view.pageX, y: view.pageY, width: view.clientWidth, height: view.clientHeight };
    }
    const scale = Math.min(1, BUDGET.SNAP_MAX_WIDTH / clip.width);
    const format: "jpeg" | "png" = opts.jpeg === true ? "jpeg" : "png";
    const params = {
      format,
      ...(format === "jpeg" ? { quality: opts.quality ?? 80 } : {}),
      clip: { ...clip, scale },
      captureBeyondViewport: beyond,
    };

    step("screenshot");
    let data = (await cdp.send("Page.captureScreenshot", params)).data;
    if (opts.stable === true) {
      step("wait for a stable frame");
      const until = Date.now() + 3000;
      while (Date.now() < until) {
        await sleep(100);
        const next = (await cdp.send("Page.captureScreenshot", params)).data;
        if (next === data) break;
        data = next;
      }
    }

    const bytes = Buffer.from(data, "base64");
    const size = imageSize(bytes);
    const ext = format === "jpeg" ? "jpg" : "png";
    const file = opts.path ?? path.join(this.snapsDir, `${stamp(new Date())}.${ext}`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
    return { path: file, width: size.width, height: size.height, bytes: bytes.length, format };
  }

  /** One CDP session per page for snapshots, opened on first use. */
  private cdpFor(page: Page): Promise<CDPSession> {
    const known = this.snapSessions.get(page);
    if (known) return known;
    const context = this.context;
    if (!context) return Promise.reject({ code: "no_page", message: "the browser is not running" });
    const opened = context.newCDPSession(page);
    opened.catch(() => this.snapSessions.delete(page));
    this.snapSessions.set(page, opened);
    return opened;
  }

  async text(cmd: CmdOf<"text">): Promise<TextResult> {
    const page = await this.pageFor(cmd.tab);
    return this.readText(page, cmd);
  }

  /**
   * C6: `target` (or the legacy selector) picks the element; without one, the
   * page's main content (`main`, else `[role=main]`), else body. `md` keeps
   * headings, list items and links as compact markdown.
   */
  private async readText(
    page: Page,
    opts: { selector?: string; target?: Target; md?: boolean; timeoutMs?: number },
  ): Promise<TextResult> {
    const timeout = opts.timeoutMs ?? BUDGET.DEFAULT_TIMEOUT_MS;
    const target: Target | undefined = opts.target ?? (opts.selector ? { selector: opts.selector } : undefined);
    const read = async (locator: Locator): Promise<TextResult> => {
      if (opts.md === true) return locator.evaluate(toMarkdown, BUDGET.TEXT_MAX_CHARS, { timeout });
      const raw = (await locator.innerText({ timeout })).replace(/\n{3,}/g, "\n\n");
      const truncated = raw.length > BUDGET.TEXT_MAX_CHARS;
      return { text: truncated ? raw.slice(0, BUDGET.TEXT_MAX_CHARS) : raw, truncated };
    };
    if (target) {
      const { locator, stable } = await this.resolveTarget(page, target);
      step("read text");
      try {
        return await read(locator);
      } catch (err) {
        // A selector (or testid, label) that matches nothing only shows here.
        if (!/Timeout \d+ms exceeded/.test(errorMessage(err))) throw err;
        throw {
          code: "target_not_found",
          message: `no element matching "${stable}" within ${timeout} ms`,
          nearMatches: await this.nearMatches(page, stable),
        };
      }
    }
    step("find main content");
    const main = await this.firstPresent([page.locator("main"), page.locator('[role="main"]')]);
    step("read text");
    if (main) {
      const text = await read(main);
      // An empty <main> (content rendered elsewhere) is no reason to return nothing.
      if (text.text.trim().length > 0) return text;
    }
    return read(page.locator("body"));
  }

  // A pinned caller sees only its tab unless it asks for allTabs; unpinned
  // (human) commands see every tab, as before.
  consoleEntries(cmd: CmdOf<"console">): ConsoleEntry[] {
    const tab = cmd.allTabs ? undefined : cmd.tab;
    return queryConsole(this.buffers.console, { all: cmd.all, filter: cmd.filter, tab });
  }

  netEntries(cmd: CmdOf<"net">): NetEntry[] {
    const tab = cmd.allTabs ? undefined : cmd.tab;
    return queryNet(this.buffers.net, { failed: cmd.failed, filter: cmd.filter, all: cmd.all, tab });
  }

  netBody(cmd: CmdOf<"netBody">): Promise<NetBodyResult> {
    return netBody(this.buffers, cmd.id);
  }

  async js(cmd: CmdOf<"js">): Promise<JsResult> {
    const page = await this.pageFor(cmd.tab);
    // Statements are fine too: the last expression statement is the result.
    const source = jsProgram(cmd.expression, BUDGET.JS_MAX_CHARS);
    let out: unknown;
    try {
      step("evaluate");
      out = await page.evaluate<unknown>(source);
    } catch (err) {
      // A redirect replaced the document under us; run once on the new one.
      if (!CONTEXT_GONE.test(errorMessage(err))) throw err;
      step("wait for load");
      await page.waitForLoadState("load", { timeout: 5000 }).catch(() => undefined);
      step("evaluate on the new document");
      out = await page.evaluate<unknown>(source);
    }
    if (
      typeof out !== "object" ||
      out === null ||
      !("json" in out) ||
      typeof out.json !== "string" ||
      !("truncated" in out) ||
      typeof out.truncated !== "boolean"
    ) {
      // The page replaced a builtin the serializer leans on.
      throw { code: "internal", message: "js: the page returned no serialized result" };
    }
    // Flows replay every js step (synthesize.ts): it may have set state later steps need.
    const shown = cmd.expression.replace(/\s+/g, " ").trim();
    this.appendAction(cmd, `ran js ${shown.length > 80 ? `${shown.slice(0, 79)}…` : shown}`, undefined, this.pageId(page));
    return { value: out.json, truncated: out.truncated };
  }

  /**
   * Install once, then poll `until` daemon-side. The whole loop costs the
   * caller one command no matter how many polls it takes, which is what makes
   * driving a real-time game affordable.
   */
  async drive(cmd: CmdOf<"drive">): Promise<DriveResult> {
    const page = await this.pageFor(cmd.tab);
    try {
      step("drive install");
      await page.evaluate(`(async () => { ${cmd.install} })()`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw { code: "internal", message: `drive install threw: ${message}` };
    }

    const timeoutMs = cmd.timeoutMs ?? 15000;
    const pollMs = cmd.pollMs ?? 500;
    const startedAt = Date.now();
    let satisfied = false;
    let polls = 0;
    // A poll that throws leaves its error message as the value: a predicate
    // that never evaluates is the caller's most useful diagnostic.
    let finalValue = "undefined";
    step("drive poll");
    for (;;) {
      let value: unknown;
      let threw = false;
      try {
        value = await page.evaluate<unknown>(`(async () => (${cmd.until}))()`);
      } catch (err) {
        threw = true;
        finalValue = err instanceof Error ? err.message : String(err);
      }
      polls++;
      if (!threw) {
        const serialized =
          value === undefined ? "undefined" : (JSON.stringify(value) ?? "undefined");
        finalValue =
          serialized.length > BUDGET.JS_MAX_CHARS
            ? serialized.slice(0, BUDGET.JS_MAX_CHARS)
            : serialized;
        if (value) {
          satisfied = true;
          break;
        }
      }
      if (Date.now() - startedAt >= timeoutMs) break;
      await sleep(pollMs);
    }
    const elapsedMs = Date.now() - startedAt;

    // A timed-out drive still ran the controller, so it belongs in the log.
    const outcome = satisfied ? "satisfied" : "timed out";
    this.appendAction(
      cmd,
      `drove until ${cmd.until.slice(0, 60)} — ${outcome} after ${elapsedMs}ms`,
      undefined,
      this.pageId(page),
    );

    return { satisfied, elapsedMs, polls, finalValue, page: this.pageInfo(page) };
  }

  async back(cmd: CmdOf<"back">): Promise<ActionResult> {
    return this.runAction(cmd, cmd.tab, async (page) => {
      await page.goBack({ waitUntil: "domcontentloaded" });
      this.refsFor(page).generation++;
      return { text: "went back" };
    }, this.settleCap(cmd.settle));
  }

  async reload(cmd: CmdOf<"reload">): Promise<ActionResult> {
    return this.runAction(cmd, cmd.tab, async (page) => {
      await page.reload({ waitUntil: "domcontentloaded" });
      this.refsFor(page).generation++;
      return { text: "reloaded" };
    }, this.settleCap(cmd.settle));
  }

  async mouse(cmd: CmdOf<"mouse">): Promise<ActionResult> {
    return this.runAction(cmd, cmd.tab, async (page) => {
      const origin = await this.resolveOrigin(page, cmd.in);
      const x = origin.x + cmd.x;
      const y = origin.y + cmd.y;
      const button = cmd.button ?? "left";
      // Canvases track hover state from mousemove, so every action starts by
      // putting the pointer where the caller asked for it.
      await page.mouse.move(x, y);
      if (cmd.action === "click") await page.mouse.click(x, y, { button });
      else if (cmd.action === "dblclick") await page.mouse.dblclick(x, y, { button });
      else if (cmd.action === "down") await page.mouse.down({ button });
      else if (cmd.action === "up") await page.mouse.up({ button });
      const where = origin.stable === undefined ? "" : ` in "${origin.stable}"`;
      return {
        text: `mouse ${cmd.action} at ${cmd.x},${cmd.y}${where}`,
        stableTarget: origin.stable,
      };
    }, this.settleCap(cmd.settle, cmd.action === "move"));
  }

  async drag(cmd: CmdOf<"drag">): Promise<ActionResult> {
    return this.runAction(cmd, cmd.tab, async (page) => {
      const origin = await this.resolveOrigin(page, cmd.in);
      const from = { x: origin.x + cmd.fromX, y: origin.y + cmd.fromY };
      const to = { x: origin.x + cmd.toX, y: origin.y + cmd.toY };
      const pointer = cmd.mode === "pointer";
      if (pointer) await this.pointerDrag(page, from, to, cmd);
      else await this.mouseDrag(page, from, to, cmd);
      const where = origin.stable === undefined ? "" : ` in "${origin.stable}"`;
      const how = pointer ? " (pointer)" : "";
      return {
        text: `dragged ${cmd.fromX},${cmd.fromY} → ${cmd.toX},${cmd.toY}${where}${how}`,
        stableTarget: origin.stable,
      };
    }, this.settleCap(cmd.settle));
  }

  /**
   * Real input events. Without holdMs/stepDelayMs this is one `mouse.move`
   * with `steps` — the cheapest path and what every existing drag does.
   */
  private async mouseDrag(page: Page, from: Point, to: Point, cmd: CmdOf<"drag">): Promise<void> {
    const steps = cmd.steps ?? 10;
    const holdMs = cmd.holdMs ?? 0;
    const stepDelayMs = cmd.stepDelayMs ?? 0;
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    if (holdMs > 0) await sleep(holdMs);
    if (stepDelayMs > 0) {
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        await page.mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
        await sleep(stepDelayMs);
      }
    } else {
      await page.mouse.move(to.x, to.y, { steps });
    }
    await page.mouse.up();
  }

  /**
   * Synthetic PointerEvents for touch-action:none / pointer-intent DnD, which
   * listens for pointer events only and never sees `page.mouse`. Every move and
   * the up go to the element that took the pointerdown — that is what
   * setPointerCapture does for real input, and it is what these UIs assume.
   * The waits run in-page so the gesture has real timing.
   */
  private async pointerDrag(page: Page, from: Point, to: Point, cmd: CmdOf<"drag">): Promise<void> {
    const found = await page.evaluate(
      async (input: {
        from: Point;
        to: Point;
        steps: number;
        holdMs: number;
        stepDelayMs: number;
      }) => {
        const target = document.elementFromPoint(input.from.x, input.from.y);
        if (!target) return false;
        const wait = (ms: number): Promise<void> =>
          new Promise((resolve) => setTimeout(resolve, ms));
        const fire = (type: string, x: number, y: number, buttons: number): void => {
          target.dispatchEvent(
            new PointerEvent(type, {
              pointerId: 1,
              isPrimary: true,
              pointerType: "mouse",
              bubbles: true,
              cancelable: true,
              composed: true,
              clientX: x,
              clientY: y,
              button: 0,
              buttons,
            }),
          );
        };
        fire("pointerdown", input.from.x, input.from.y, 1);
        if (input.holdMs > 0) await wait(input.holdMs);
        for (let i = 1; i <= input.steps; i++) {
          const t = i / input.steps;
          fire(
            "pointermove",
            input.from.x + (input.to.x - input.from.x) * t,
            input.from.y + (input.to.y - input.from.y) * t,
            1,
          );
          if (input.stepDelayMs > 0) await wait(input.stepDelayMs);
        }
        fire("pointerup", input.to.x, input.to.y, 0);
        return true;
      },
      {
        from,
        to,
        steps: cmd.steps ?? 20,
        holdMs: cmd.holdMs ?? 120,
        stepDelayMs: cmd.stepDelayMs ?? 16,
      },
    );
    if (!found) {
      throw {
        code: "target_not_found",
        message: `nothing at ${Math.round(from.x)},${Math.round(from.y)} to start a pointer drag from`,
      };
    }
  }

  async key(cmd: CmdOf<"key">): Promise<ActionResult> {
    return this.runAction(cmd, cmd.tab, async (page) => {
      if (cmd.action === "down") await page.keyboard.down(cmd.key);
      else await page.keyboard.up(cmd.key);
      return { text: `key ${cmd.action} "${cmd.key}"` };
    }, this.settleCap(cmd.settle, true));
  }

  async wheel(cmd: CmdOf<"wheel">): Promise<ActionResult> {
    return this.runAction(cmd, cmd.tab, async (page) => {
      let stable: string | undefined;
      if (cmd.in && cmd.x === undefined && cmd.y === undefined) {
        // G3: `wheel --in <target>` alone scrolls that element into view.
        const resolved = await this.resolveTarget(page, cmd.in);
        step("scroll into view");
        await resolved.locator.scrollIntoViewIfNeeded({ timeout: BUDGET.DEFAULT_TIMEOUT_MS });
        const done = `scrolled "${resolved.stable}" into view`;
        if (cmd.deltaY === 0) return { text: done, stableTarget: resolved.stable };
        // Then wheel over it, so a scrollable element scrolls rather than the page.
        const box = await resolved.locator.boundingBox();
        if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(0, cmd.deltaY);
        return { text: `${done}, then wheel ${cmd.deltaY}`, stableTarget: resolved.stable };
      }
      if (cmd.x !== undefined || cmd.y !== undefined) {
        const origin = await this.resolveOrigin(page, cmd.in);
        await page.mouse.move(origin.x + (cmd.x ?? 0), origin.y + (cmd.y ?? 0));
        stable = origin.stable;
      }
      await page.mouse.wheel(0, cmd.deltaY);
      return { text: `wheel ${cmd.deltaY}`, stableTarget: stable };
    }, this.settleCap(cmd.settle));
  }

  async tabs(): Promise<TabsResult> {
    const context = await this.ensureContext();
    return { pages: context.pages().map((p) => this.pageInfo(p)) };
  }

  /**
   * A background tab is created without becoming active and without taking
   * focus — the operator keeps whatever tab they were on. Every agent opens its
   * pinned tab this way; a foreground tab is a human asking for a new tab.
   */
  private async newPage(context: BrowserContext, background: boolean): Promise<Page> {
    const stay = this.activePage();
    // newPage() pages have no opener, so onNewPage never activates them.
    const page = await context.newPage();
    if (!background) {
      this.active = page;
      return page;
    }
    // Chrome foregrounds a freshly opened tab regardless of what we track.
    if (stay && !stay.isClosed()) await stay.bringToFront().catch(() => undefined);
    this.active = stay ?? page;
    return page;
  }

  async tabNew(cmd: CmdOf<"tabNew">): Promise<TabsResult> {
    const context = await this.ensureContext();
    const page = await this.newPage(context, cmd.background === true);
    if (cmd.url !== undefined) {
      const url = HAS_SCHEME.test(cmd.url) || OPAQUE_SCHEME.test(cmd.url) ? cmd.url : `https://${cmd.url}`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    }
    const what = cmd.background === true ? "a new background tab" : "a new tab";
    this.appendAction(
      cmd,
      cmd.url === undefined ? `opened ${what}` : `opened ${what} at ${cmd.url}`,
      undefined,
      this.pageId(page),
    );
    // `created` is how a pinning caller learns its tab id without racing
    // whichever tab happens to be active by the time it reads the list.
    const tabs = await this.tabs();
    return { ...tabs, created: this.pageInfo(page) };
  }

  async tabSelect(cmd: CmdOf<"tabSelect">): Promise<TabsResult> {
    const context = await this.ensureContext();
    const page = context.pages()[cmd.index];
    if (!page) throw { code: "bad_request", message: `no tab at index ${cmd.index}` };
    this.active = page;
    await page.bringToFront().catch(() => undefined);
    this.appendAction(cmd, `selected tab ${cmd.index}`, undefined, this.pageId(page));
    return this.tabs();
  }

  async tabClose(cmd: CmdOf<"tabClose">): Promise<TabsResult> {
    const context = await this.ensureContext();

    // Bulk cleanup. `others` keeps the active tab and nukes the rest; `all`
    // nukes everything and leaves one fresh blank tab so the persistent context
    // (and the daemon) survives instead of the browser closing under us.
    if (cmd.scope !== undefined) {
      const pages = context.pages();
      const keep = cmd.scope === "others" ? (this.activePage() ?? pages[0]) : undefined;
      let closed = 0;
      for (const page of [...pages]) {
        if (page === keep) continue;
        await page.close().catch(() => undefined);
        closed++;
      }
      if (context.pages().length === 0) await context.newPage();
      this.active = keep ?? context.pages()[0] ?? null;
      const what =
        cmd.scope === "others"
          ? `closed ${closed} other tab${closed === 1 ? "" : "s"}`
          : `closed all ${closed} tab${closed === 1 ? "" : "s"}`;
      this.appendAction(cmd, what, undefined, keep ? this.pageId(keep) : undefined);
      return this.tabs();
    }

    const page = await this.pageFor(cmd.tab);
    const closed = context.pages().indexOf(page);
    // Closing another tab leaves the active page alone (it is held by
    // identity); closing the active one falls back via the close handler.
    await page.close();
    this.appendAction(cmd, `closed tab ${closed}`, undefined, this.pageId(page));
    return this.tabs();
  }

  async status(): Promise<StatusResult> {
    const pages = this.context
      ? this.context.pages().map((p) => this.pageInfo(p))
      : [];
    return {
      profile: this.profile,
      headless: this.headless,
      browserRunning: this.browserRunning,
      pages,
      recording: recordingSlug(),
      uptimeMs: Date.now() - this.startedAt,
      relaunches: this.relaunches,
    };
  }

  /** Pages with Chrome's counters, plus the sizes of everything this session keeps. */
  /** light: no per-page CDP session or Performance.getMetrics (metrics: null). */
  async debugInfo(opts: { light?: boolean } = {}): Promise<Pick<DebugResult, "pages" | "internals">> {
    const pages = this.context?.pages() ?? [];
    const out = await Promise.all(
      pages.map(async (page): Promise<DebugPage> => {
        const info = this.pageInfo(page);
        const metrics = opts.light ? null : await this.pageMetrics(page);
        return {
          tab: info.id,
          url: info.url,
          title: info.title,
          active: info.active,
          metrics,
          refs: this.refs.get(info.id)?.entries.size ?? 0,
        };
      }),
    );
    let refEntries = 0;
    for (const r of this.refs.values()) refEntries += r.entries.size;
    return {
      pages: out,
      internals: {
        actionLog: this.actions.size,
        actionLogChars: this.actions.chars,
        actionLogDropped: this.actions.dropped,
        actionLogCap: ACTION_LOG_CAP,
        refPages: this.refs.size,
        refEntries,
        consolePushed: this.buffers.console.length,
        netPushed: this.buffers.net.length,
        ringCap: BUDGET.RING_BUFFER_SIZE,
      },
    };
  }

  private async pageMetrics(page: Page): Promise<DebugPageMetrics | null> {
    const context = this.context;
    if (!context || page.isClosed()) return null;
    let pending = this.metricSessions.get(page);
    if (!pending) {
      pending = context.newCDPSession(page).then(async (s) => {
        await s.send("Performance.enable");
        return s;
      });
      this.metricSessions.set(page, pending);
    }
    const read = pending.then((s) => s.send("Performance.getMetrics"));
    const answer = await Promise.race([read, sleep(800).then(() => null)]).catch(() => {
      // The session died with a navigation or crash; open a fresh one next read.
      this.metricSessions.delete(page);
      return null;
    });
    if (!answer) return null;
    const m = new Map(answer.metrics.map((x) => [x.name, x.value]));
    const n = (name: string): number => m.get(name) ?? 0;
    return {
      jsHeapUsed: n("JSHeapUsedSize"),
      jsHeapTotal: n("JSHeapTotalSize"),
      nodes: n("Nodes"),
      documents: n("Documents"),
      listeners: n("JSEventListeners"),
      frames: n("Frames"),
      layoutCount: n("LayoutCount"),
      scriptMs: Math.round(n("ScriptDuration") * 1000),
      taskMs: Math.round(n("TaskDuration") * 1000),
    };
  }

  actionLog(cmd: CmdOf<"actionLog">): ActionLogResult {
    return {
      entries: this.actions.since(cmd.sinceIndex ?? 0),
      nextIndex: this.actions.nextIndex,
    };
  }

  // -------------------------------------------------------------------------
  // Recording support (record.ts)
  // -------------------------------------------------------------------------

  /** The live context, or null when the browser is not running. */
  get liveContext(): BrowserContext | null {
    return this.context;
  }

  /** Wall-clock origin that `ActionLogEntry.t` is measured from. */
  get logTimeOrigin(): number {
    return this.buffers.t0;
  }

  /**
   * Read-only view of a page's stable tab id — recording pairs each context
   * page's video with its tab so it can select the tab that was actually
   * driven (by action count) rather than the largest webm.
   */
  tabIdOf(page: Page): number {
    return this.pageId(page);
  }

  /**
   * Reopens the browser with different context options, restoring the active
   * page's URL. Video capture can only be switched on when a context is
   * created, and the webm is only flushed when it closes — so starting and
   * stopping a recording both come through here.
   */
  async relaunch(extra?: RelaunchOptions): Promise<void> {
    const previous = this.context;
    const activeUrl = previous ? this.activePage()?.url() : undefined;

    this.context = null;
    if (previous) await previous.close().catch(() => undefined);

    let context: BrowserContext;
    try {
      context = await this.launch(extra);
    } catch (err) {
      throw { code: "browser_launch_failed", message: errorMessage(err) };
    }
    this.dead = false;

    const page = context.pages()[0] ?? (await context.newPage());
    if (activeUrl !== undefined && !OPAQUE_SCHEME.test(activeUrl)) {
      await page
        .goto(activeUrl, { waitUntil: "domcontentloaded", timeout: 15000 })
        .catch(() => undefined);
    }
    this.active = page;
    // Refs registered against the old context cannot resolve in the new one,
    // and its page ids are gone with it.
    this.refs.clear();
  }
}
