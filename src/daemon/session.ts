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
import type { BrowserContext, Locator, Page } from "playwright-core";

type CmdOf<K extends Cmd["cmd"]> = Extract<Cmd, { cmd: K }>;

interface Resolved {
  locator: Locator;
  /** Replay-stable identity recorded at resolution time; never a ref. */
  stable: string;
}

/** Viewport point the coordinate verbs offset from; `stable` names the `in`. */
interface Origin {
  x: number;
  y: number;
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
  private nextPageId = 1;
  private readonly pageIds = new WeakMap<Page, number>();
  private readonly refs = new Map<number, PageRefs>();
  private readonly actions: ActionLogEntry[] = [];
  private readonly buffers: Buffers;
  private readonly startedAt = Date.now();

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
    context.on("page", (page) => {
      this.track(page);
      this.activeIndex = Math.max(0, context.pages().length - 1);
    });
    return context;
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

  private appendAction(cmd: Cmd, text: string, stableTarget?: string): void {
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
    if (cmd) this.appendAction(cmd, text, stableTarget);
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
    this.appendAction({ cmd: "open", url }, `opened ${url}`, url);
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
      this.appendAction(cmd, `expect ${kind} "${cmd.value}"`);
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
      await page.mouse.move(origin.x + cmd.fromX, origin.y + cmd.fromY);
      await page.mouse.down();
      await page.mouse.move(origin.x + cmd.toX, origin.y + cmd.toY, { steps: cmd.steps ?? 10 });
      await page.mouse.up();
      const where = origin.stable === undefined ? "" : ` in "${origin.stable}"`;
      return {
        text: `dragged ${cmd.fromX},${cmd.fromY} → ${cmd.toX},${cmd.toY}${where}`,
        stableTarget: origin.stable,
      };
    });
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

  async tabNew(cmd: CmdOf<"tabNew">): Promise<TabsResult> {
    const context = await this.ensureContext();
    const page = await context.newPage();
    this.activeIndex = Math.max(0, context.pages().indexOf(page));
    if (cmd.url !== undefined) {
      const url = HAS_SCHEME.test(cmd.url) || OPAQUE_SCHEME.test(cmd.url) ? cmd.url : `https://${cmd.url}`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    }
    this.appendAction(cmd, cmd.url === undefined ? "opened a new tab" : `opened a new tab at ${cmd.url}`);
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
    this.appendAction(cmd, `selected tab ${cmd.index}`);
    return this.tabs();
  }

  async tabClose(cmd: CmdOf<"tabClose">): Promise<TabsResult> {
    const context = await this.ensureContext();
    const page = await this.pageFor(cmd.tab);
    const closed = context.pages().indexOf(page);
    await page.close();
    // Closing a tab ahead of the active one shifts it down; the active page
    // itself must not change.
    if (closed >= 0 && closed < this.activeIndex) this.activeIndex--;
    this.appendAction(cmd, `closed tab ${closed}`);
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
    context.on("page", (page) => {
      this.track(page);
      this.activeIndex = Math.max(0, context.pages().length - 1);
    });

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
