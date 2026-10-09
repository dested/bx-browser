// The browser session: one persistent Chrome context per profile, lazily
// launched, plus the ref registry that makes `bx click 3` work.

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
import { distillPage, renderEls, type DistillResult } from "./distill.ts";
import { seedOsPasswordCheck } from "./osPassword.ts";
import {
  RingBuffer,
  attachObservers,
  markConsole,
  newErrorsSince,
  queryConsole,
  queryNet,
  type Buffers,
} from "./observe.ts";
import { recordingSlug } from "./record.ts";
import type { BrowserContext, CDPSession, Locator, Page } from "playwright-core";

type CmdOf<K extends Cmd["cmd"]> = Extract<Cmd, { cmd: K }>;

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

const SETTLE_MS = 150;
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

export class Session {
  readonly profile: string;
  readonly headless: boolean;
  private readonly profileDir: string;
  private readonly snapsDir: string;
  private context: BrowserContext | null = null;
  private activeIndex = 0;
  /**
   * Non-zero while a background `tabNew` is creating its page, so the context's
   * "page" handler leaves activeIndex alone. Without this, an agent opening its
   * own pinned tab would redirect the operator's unpinned commands into it.
   * Pages the site itself opens (window.open) still activate.
   */
  private suppressActivate = 0;
  private nextPageId = 1;
  private readonly pageIds = new WeakMap<Page, number>();
  private readonly refs = new Map<number, PageRefs>();
  private readonly actions: ActionLogEntry[] = [];
  private readonly buffers: Buffers;
  private readonly startedAt = Date.now();
  /** Opened on the first /debug read of a page, never by ordinary commands. */
  private readonly metricSessions = new WeakMap<Page, Promise<CDPSession>>();

  constructor(opts: SessionOptions) {
    this.profile = opts.profile;
    this.headless = opts.headless;
    const bx = path.join(os.homedir(), BX_DIR_NAME);
    this.profileDir = path.join(bx, PROFILES_DIR, opts.profile);
    this.snapsDir = path.join(bx, SNAPS_DIR);
    this.buffers = {
      console: new RingBuffer<ConsoleEntry>(BUDGET.RING_BUFFER_SIZE),
      net: new RingBuffer<NetEntry>(BUDGET.RING_BUFFER_SIZE),
      t0: Date.now(),
    };
  }

  get browserRunning(): boolean {
    return this.context !== null;
  }

  // -------------------------------------------------------------------------
  // Browser lifecycle
  // -------------------------------------------------------------------------

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    const { chromium } = await import("playwright-core");
    // Must precede every launch: a cold profile makes Chrome probe the Windows
    // password with a failed logon, and enough of those lock the account.
    console.log(`[${new Date().toISOString()}] ${seedOsPasswordCheck(this.profileDir)}`);
    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(this.profileDir, {
        channel: "chrome",
        headless: this.headless,
        viewport: { width: 1280, height: 800 },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw {
        code: "browser_launch_failed",
        message: `${message} — is another bx daemon using profile "${this.profile}"?`,
      };
    }
    this.context = context;
    for (const page of context.pages()) this.track(page);
    context.on("page", (page) => this.onNewPage(context, page));
    return context;
  }

  private onNewPage(context: BrowserContext, page: Page): void {
    this.track(page);
    if (this.suppressActivate > 0) return;
    this.activeIndex = Math.max(0, context.pages().length - 1);
  }

  private track(page: Page): void {
    const id = this.pageId(page);
    attachObservers(page, this.buffers);
    page.on("close", () => {
      this.refs.delete(id);
      const count = this.context?.pages().length ?? 0;
      if (this.activeIndex >= count) this.activeIndex = Math.max(0, count - 1);
    });
  }

  private async ensurePage(): Promise<Page> {
    const context = await this.ensureContext();
    let pages = context.pages();
    if (pages.length === 0) {
      await context.newPage();
      pages = context.pages();
    }
    if (this.activeIndex >= pages.length) this.activeIndex = pages.length - 1;
    const page = pages[this.activeIndex];
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
    if (!page) throw { code: "no_page", message: `tab ${tab} is closed` };
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

  private async pageInfo(page: Page): Promise<PageInfo> {
    const pages = this.context?.pages() ?? [];
    const index = pages.indexOf(page);
    let title = "";
    try {
      title = await page.title();
    } catch {
      // navigating or closing; the url alone is enough
    }
    return {
      index: index < 0 ? 0 : index,
      id: this.pageId(page),
      url: page.url(),
      title,
      active: index === this.activeIndex,
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
      index: this.actions.length,
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
   */
  private async runAction(
    cmd: Cmd | null,
    tab: number | undefined,
    perform: (page: Page) => Promise<{ text: string; stableTarget?: string }>,
  ): Promise<ActionResult> {
    const page = await this.pageFor(tab);
    const urlBefore = page.url();
    const mark = markConsole(this.buffers.console);
    const { text, stableTarget } = await perform(page);
    await sleep(SETTLE_MS);
    const navigated = urlBefore !== page.url();
    if (navigated) this.refsFor(page).generation++;
    const result: ActionResult = {
      page: await this.pageInfo(page),
      navigated,
      consoleErrors: newErrorsSince(this.buffers.console, mark).slice(0, 5),
    };
    if (cmd) this.appendAction(cmd, text, stableTarget, this.pageId(page));
    return result;
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
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    const scan = await this.scan(page);
    this.appendAction({ cmd: "open", url }, `opened ${url}`, url, this.pageId(page));
    return {
      page: await this.pageInfo(page),
      els: { generation: this.refsFor(page).generation, ...renderEls(scan, {}) },
    };
  }

  async els(cmd: CmdOf<"els">): Promise<ElsResult> {
    const page = await this.pageFor(cmd.tab);
    const scan = await this.scan(page);
    return {
      generation: this.refsFor(page).generation,
      ...renderEls(scan, { all: cmd.all, filter: cmd.filter }),
    };
  }

  async click(cmd: CmdOf<"click">): Promise<ActionResult> {
    return this.runAction(cmd, cmd.tab, async (page) => {
      const { locator, stable } = await this.resolveTarget(page, cmd.target);
      await locator.click({ timeout: cmd.timeoutMs ?? BUDGET.DEFAULT_TIMEOUT_MS });
      return { text: `clicked "${stable}"`, stableTarget: stable };
    });
  }

  async fill(cmd: CmdOf<"fill">): Promise<ActionResult> {
    return this.runAction(cmd, cmd.tab, async (page) => {
      const { locator, stable } = await this.resolveTarget(page, cmd.target);
      const type = await locator.getAttribute("type").catch(() => null);
      await locator.fill(cmd.value, { timeout: cmd.timeoutMs ?? BUDGET.DEFAULT_TIMEOUT_MS });
      const shown = type === "password" ? "•••" : cmd.value;
      return { text: `filled "${stable}" with "${shown}"`, stableTarget: stable };
    });
  }

  async select(cmd: CmdOf<"select">): Promise<ActionResult> {
    return this.runAction(cmd, cmd.tab, async (page) => {
      const { locator, stable } = await this.resolveTarget(page, cmd.target);
      const timeout = cmd.timeoutMs ?? BUDGET.DEFAULT_TIMEOUT_MS;
      try {
        await locator.selectOption({ value: cmd.value }, { timeout });
      } catch {
        await locator.selectOption({ label: cmd.value }, { timeout });
      }
      return { text: `selected "${cmd.value}" in "${stable}"`, stableTarget: stable };
    });
  }

  async press(cmd: CmdOf<"press">): Promise<ActionResult> {
    return this.runAction(cmd, cmd.tab, async (page) => {
      await page.keyboard.press(cmd.key);
      return { text: `pressed ${cmd.key}` };
    });
  }

  async wait(cmd: CmdOf<"wait">): Promise<ActionResult> {
    const given = [cmd.text, cmd.selector, cmd.ms].filter((v) => v !== undefined).length;
    if (given !== 1) {
      throw { code: "bad_request", message: "wait takes exactly one of --text, --selector, --ms" };
    }
    const timeout = cmd.timeoutMs ?? BUDGET.DEFAULT_TIMEOUT_MS;
    return this.runAction(null, cmd.tab, async (page) => {
      if (cmd.ms !== undefined) {
        await sleep(Math.min(cmd.ms, 30000));
      } else if (cmd.text !== undefined) {
        await page.getByText(cmd.text).first().waitFor({ state: "visible", timeout });
      } else if (cmd.selector !== undefined) {
        await page.locator(cmd.selector).first().waitFor({ state: "visible", timeout });
      }
      return { text: "waited" };
    });
  }

  async expect(cmd: CmdOf<"expect">): Promise<ExpectResult> {
    const page = await this.pageFor(cmd.tab);
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
    const original = await page.screenshot({ fullPage: cmd.full === true });
    const viewport = page.viewportSize();

    let bytes = original;
    let width = viewport?.width ?? 0;
    let height = viewport?.height ?? 0;
    try {
      const scaled = await page.evaluate(
        async (input: { b64: string; maxWidth: number }) => {
          const blob = await (await fetch(`data:image/png;base64,${input.b64}`)).blob();
          const bitmap = await createImageBitmap(blob);
          if (bitmap.width <= input.maxWidth) {
            return { b64: null, width: bitmap.width, height: bitmap.height };
          }
          const scale = input.maxWidth / bitmap.width;
          const w = Math.round(bitmap.width * scale);
          const h = Math.round(bitmap.height * scale);
          const canvas = new OffscreenCanvas(w, h);
          const ctx = canvas.getContext("2d");
          if (!ctx) return { b64: null, width: bitmap.width, height: bitmap.height };
          ctx.drawImage(bitmap, 0, 0, w, h);
          const out = await canvas.convertToBlob({ type: "image/png" });
          const buf = new Uint8Array(await out.arrayBuffer());
          let binary = "";
          for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i] ?? 0);
          return { b64: btoa(binary), width: w, height: h };
        },
        { b64: original.toString("base64"), maxWidth: BUDGET.SNAP_MAX_WIDTH },
      );
      width = scaled.width;
      height = scaled.height;
      if (scaled.b64 !== null) bytes = Buffer.from(scaled.b64, "base64");
    } catch {
      // no OffscreenCanvas (or the page blocks data: fetches) — ship full size
    }

    const target = cmd.path ?? path.join(this.snapsDir, `${stamp(new Date())}.png`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
    return { path: target, width, height, bytes: bytes.length };
  }

  async text(cmd: CmdOf<"text">): Promise<TextResult> {
    const page = await this.pageFor(cmd.tab);
    const locator = cmd.selector ? page.locator(cmd.selector).first() : page.locator("body");
    const raw = (await locator.innerText()).replace(/\n{3,}/g, "\n\n");
    const truncated = raw.length > BUDGET.TEXT_MAX_CHARS;
    return { text: truncated ? raw.slice(0, BUDGET.TEXT_MAX_CHARS) : raw, truncated };
  }

  consoleEntries(cmd: CmdOf<"console">): ConsoleEntry[] {
    return queryConsole(this.buffers.console, { all: cmd.all, filter: cmd.filter });
  }

  netEntries(cmd: CmdOf<"net">): NetEntry[] {
    return queryNet(this.buffers.net, { failed: cmd.failed, filter: cmd.filter });
  }

  async js(cmd: CmdOf<"js">): Promise<JsResult> {
    const page = await this.pageFor(cmd.tab);
    const value = await page.evaluate<unknown>(`(async () => (${cmd.expression}))()`);
    const serialized = value === undefined ? "undefined" : (JSON.stringify(value) ?? "undefined");
    const truncated = serialized.length > BUDGET.JS_MAX_CHARS;
    return {
      value: truncated ? serialized.slice(0, BUDGET.JS_MAX_CHARS) : serialized,
      truncated,
    };
  }

  /**
   * Install once, then poll `until` daemon-side. The whole loop costs the
   * caller one command no matter how many polls it takes, which is what makes
   * driving a real-time game affordable.
   */
  async drive(cmd: CmdOf<"drive">): Promise<DriveResult> {
    const page = await this.pageFor(cmd.tab);
    try {
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

    return { satisfied, elapsedMs, polls, finalValue, page: await this.pageInfo(page) };
  }

  async back(cmd: CmdOf<"back">): Promise<ActionResult> {
    return this.runAction(cmd, cmd.tab, async (page) => {
      await page.goBack({ waitUntil: "domcontentloaded" });
      this.refsFor(page).generation++;
      return { text: "went back" };
    });
  }

  async reload(cmd: CmdOf<"reload">): Promise<ActionResult> {
    return this.runAction(cmd, cmd.tab, async (page) => {
      await page.reload({ waitUntil: "domcontentloaded" });
      this.refsFor(page).generation++;
      return { text: "reloaded" };
    });
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
    });
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
    });
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
    });
  }

  async wheel(cmd: CmdOf<"wheel">): Promise<ActionResult> {
    return this.runAction(cmd, cmd.tab, async (page) => {
      let stable: string | undefined;
      if (cmd.x !== undefined || cmd.y !== undefined) {
        const origin = await this.resolveOrigin(page, cmd.in);
        await page.mouse.move(origin.x + (cmd.x ?? 0), origin.y + (cmd.y ?? 0));
        stable = origin.stable;
      }
      await page.mouse.wheel(0, cmd.deltaY);
      return { text: `wheel ${cmd.deltaY}`, stableTarget: stable };
    });
  }

  async tabs(): Promise<TabsResult> {
    const context = await this.ensureContext();
    return { pages: await Promise.all(context.pages().map((p) => this.pageInfo(p))) };
  }

  /**
   * A background tab is created without becoming active and without taking
   * focus — the operator keeps whatever tab they were on. Every agent opens its
   * pinned tab this way; a foreground tab is a human asking for a new tab.
   */
  private async newPage(context: BrowserContext, background: boolean): Promise<Page> {
    if (!background) {
      const page = await context.newPage();
      this.activeIndex = Math.max(0, context.pages().indexOf(page));
      return page;
    }
    const stay = context.pages()[this.activeIndex];
    this.suppressActivate++;
    let page: Page;
    try {
      page = await context.newPage();
    } finally {
      this.suppressActivate--;
    }
    // Chrome foregrounds a freshly opened tab regardless of what we track.
    if (stay && !stay.isClosed()) await stay.bringToFront().catch(() => undefined);
    this.activeIndex = context.pages().indexOf(stay ?? page);
    if (this.activeIndex < 0) this.activeIndex = 0;
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
    return { ...tabs, created: await this.pageInfo(page) };
  }

  async tabSelect(cmd: CmdOf<"tabSelect">): Promise<TabsResult> {
    const context = await this.ensureContext();
    const page = context.pages()[cmd.index];
    if (!page) throw { code: "bad_request", message: `no tab at index ${cmd.index}` };
    this.activeIndex = cmd.index;
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
      const keep = cmd.scope === "others" ? (pages[this.activeIndex] ?? pages[0]) : undefined;
      let closed = 0;
      for (const page of [...pages]) {
        if (page === keep) continue;
        await page.close().catch(() => undefined);
        closed++;
      }
      if (context.pages().length === 0) await context.newPage();
      this.activeIndex = keep ? Math.max(0, context.pages().indexOf(keep)) : 0;
      const what =
        cmd.scope === "others"
          ? `closed ${closed} other tab${closed === 1 ? "" : "s"}`
          : `closed all ${closed} tab${closed === 1 ? "" : "s"}`;
      this.appendAction(cmd, what, undefined, keep ? this.pageId(keep) : undefined);
      return this.tabs();
    }

    const page = await this.pageFor(cmd.tab);
    const before = context.pages();
    const closed = before.indexOf(page);
    const stay = before[this.activeIndex];
    await page.close();
    // Closing any other tab shifts the indexes around the active page but must
    // not change which page is active — so re-find it by identity rather than
    // patching the index (the page's own close handler already clamped it).
    const after = context.pages();
    const kept = stay && stay !== page ? after.indexOf(stay) : -1;
    if (kept >= 0) this.activeIndex = kept;
    else this.activeIndex = Math.max(0, Math.min(this.activeIndex, after.length - 1));
    this.appendAction(cmd, `closed tab ${closed}`, undefined, this.pageId(page));
    return this.tabs();
  }

  async status(): Promise<StatusResult> {
    const pages = this.context
      ? await Promise.all(this.context.pages().map((p) => this.pageInfo(p)))
      : [];
    return {
      profile: this.profile,
      headless: this.headless,
      browserRunning: this.browserRunning,
      pages,
      recording: recordingSlug(),
      uptimeMs: Date.now() - this.startedAt,
    };
  }

  /** Pages with Chrome's counters, plus the sizes of everything this session keeps. */
  async debugInfo(): Promise<Pick<DebugResult, "pages" | "internals">> {
    const pages = this.context?.pages() ?? [];
    const out = await Promise.all(
      pages.map(async (page): Promise<DebugPage> => {
        const [info, metrics] = await Promise.all([this.pageInfo(page), this.pageMetrics(page)]);
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
    let actionLogChars = 0;
    for (const a of this.actions) actionLogChars += a.text.length + a.cmdJson.length + (a.stableTarget?.length ?? 0);
    let refEntries = 0;
    for (const r of this.refs.values()) refEntries += r.entries.size;
    return {
      pages: out,
      internals: {
        actionLog: this.actions.length,
        actionLogChars,
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
      entries: this.actions.slice(cmd.sinceIndex ?? 0),
      nextIndex: this.actions.length,
    };
  }

  // -------------------------------------------------------------------------
  // Recording support (record.ts)
  // -------------------------------------------------------------------------

  /** The live context, or null when the browser is not running. */
  get liveContext(): BrowserContext | null {
    return this.context;
  }

  /** The live action log; recording slices it for the transcript. */
  get actionEntries(): readonly ActionLogEntry[] {
    return this.actions;
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
   *
   * The launch options are repeated rather than shared with ensureContext so
   * this stays purely additive against concurrent edits to the launch path.
   */
  async relaunch(extra?: RelaunchOptions): Promise<void> {
    const previous = this.context;
    const urls = previous ? previous.pages().map((page) => page.url()) : [];
    const activeUrl = urls[this.activeIndex] ?? urls[0];

    this.context = null;
    if (previous) await previous.close().catch(() => undefined);

    const { chromium } = await import("playwright-core");
    console.log(`[${new Date().toISOString()}] ${seedOsPasswordCheck(this.profileDir)}`);
    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(this.profileDir, {
        channel: "chrome",
        headless: this.headless,
        viewport: { width: 1280, height: 800 },
        ...extra,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw { code: "browser_launch_failed", message };
    }

    this.context = context;
    for (const page of context.pages()) this.track(page);
    context.on("page", (p) => this.onNewPage(context, p));

    const page = context.pages()[0] ?? (await context.newPage());
    if (activeUrl !== undefined && !OPAQUE_SCHEME.test(activeUrl)) {
      await page
        .goto(activeUrl, { waitUntil: "domcontentloaded", timeout: 15000 })
        .catch(() => undefined);
    }
    this.activeIndex = 0;
    // Refs registered against the old context cannot resolve in the new one,
    // and its page ids are gone with it.
    this.refs.clear();
  }
}
