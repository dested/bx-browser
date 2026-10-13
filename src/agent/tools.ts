// bx verbs exposed to the driver model as in-process MCP tools.
//
// Two rules govern every handler here:
//   1. Never throw. A thrown tool error reads as a dead end to a small model;
//      the same information as text ("not found — did you mean [4] …") is
//      something it can act on. Failures are returned, not raised.
//   2. Text unless asked. The driver is text-only by default, so bx_snap yields
//      a path; only a --vision run gets the image itself.
//
// Turn economy is the other design force: every action can fold its follow-up
// observation into the same call (`then`), reports what changed (`delta`), and
// rescans send only what changed since the last scan.

import { readFile } from "node:fs/promises";

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { cmd } from "../client.ts";
import { parseTarget } from "../client.ts";
import type {
  ActionResult,
  BxError,
  Cmd,
  CmdResult,
  ConsoleEntry,
  DriveResult,
  ElsResult,
  ExpectResult,
  JsResult,
  OpenResult,
  PageInfo,
  SnapResult,
  TabsResult,
  Target,
  TextResult,
} from "../protocol.ts";

/** How a completed run reports back to the driver. */
export interface ToolSink {
  setReport(r: { status: "pass" | "fail"; summary: string; evidence: string[] }): void;
}

export const BX_SERVER_NAME = "bx";

/** bx_wait refuses longer fixed sleeps: waiting for a condition is one turn, polling is many. */
const WAIT_MS_MAX = 1000;
const VISION_JPEG_QUALITY = 70;

// ---------------------------------------------------------------------------
// Result plumbing
// ---------------------------------------------------------------------------

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: ToolContent[] };

function say(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/**
 * Runs a daemon command, collapsing a thrown transport/launch failure into the
 * same CmdResult shape the daemon returns, so callers only handle one shape.
 */
async function call<T>(profile: string, c: Cmd): Promise<CmdResult<T>> {
  try {
    return await cmd<T>(profile, c);
  } catch (e: unknown) {
    return {
      ok: false,
      error: { code: "internal", message: e instanceof Error ? e.message : String(e) },
    };
  }
}

/** `did you mean` candidates are what let a small model repair its own target. */
function renderError(err: BxError): string {
  const near = err.nearMatches ?? [];
  const label = err.code === "ambiguous" ? "candidate" : "did you mean";
  const lines = near.map((e) => `${label}: [${e.ref}] ${e.role} "${e.name}"`);
  if (err.code === "ambiguous") {
    lines.push("pass the ref number of the one you mean");
  }
  return [`error (${err.code}): ${err.message}`, ...lines].join("\n");
}

function renderEls(r: ElsResult): string {
  const body = r.rendered.trim();
  const d = r.diff;
  if (d === undefined) return body || "(no interactive elements)";
  if (d.added === 0 && d.changed === 0 && d.removed.length === 0) {
    return "(no changes since your last scan — its refs are still valid)";
  }
  const removed = d.removed.length > 0 ? `, gone: ${d.removed.map((r) => `[${r}]`).join(" ")}` : "";
  const head = `changes since your last scan: ${d.added} new, ${d.changed} changed${removed} (unlisted refs are unchanged and still valid)`;
  return body ? `${head}\n${body}` : head;
}

function renderText(r: TextResult): string {
  return r.truncated ? `${r.text}\n…(truncated)` : r.text;
}

/** What an action changed, one short line per fact. Absent facts cost nothing. */
function deltaLines(r: ActionResult): string[] {
  const lines: string[] = [];
  const d = r.delta;
  if (d === undefined) {
    if (r.navigated) lines.push(`now at ${r.page.url} — ${r.page.title}`);
    return lines;
  }
  if (d.url !== undefined || r.navigated) lines.push(`now at ${d.url ?? r.page.url}`);
  if (d.title !== undefined) lines.push(`title: ${d.title}`);
  if (d.dialog !== undefined) lines.push(`dialog ${d.dialog}`);
  for (const alert of d.alerts ?? []) lines.push(`alert: ${alert}`);
  if (d.focused !== undefined) lines.push(`focused: ${d.focused}`);
  if (d.newTab !== undefined) {
    lines.push(
      `opened new tab ${d.newTab.id}: ${d.newTab.url} — your tab is unchanged; bx_tabs switch ${d.newTab.id} to work there`,
    );
  }
  if (d.added > 0 || d.removed > 0) lines.push(`dom: +${d.added} −${d.removed} elements`);
  else if (lines.length === 0) lines.push("no visible change");
  return lines;
}

/** parseTarget rejects malformed input by throwing; the model gets text instead. */
function toTarget(raw: string): { ok: true; target: Target } | { ok: false; message: string } {
  try {
    return { ok: true, target: parseTarget(raw) };
  } catch (e: unknown) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Tab pinning
// ---------------------------------------------------------------------------

/**
 * One home tab per tools instance. Every run gets its own page and pins each
 * command to it, so concurrent runs against one daemon cannot navigate, scan,
 * or click in each other's page. Popups the run opens are adopted: the model
 * can switch its pin to one, and they are closed with the home tab.
 */
interface TabPin {
  /** The tab commands go to now; undefined only when the daemon could not make one. */
  tab(): Promise<number | undefined>;
  /** The home tab's id, once creation finished; undefined before. Never forces creation. */
  homeId(): number | undefined;
  /** Every tab this run owns: home plus adopted popups. */
  owned(): number[];
  adopt(id: number): void;
  /** Re-points the pin; the id must be owned. */
  switchTo(id: number): void;
  release(id: number): void;
  close(): Promise<void>;
}

function createTabPin(profile: string, startUrl?: string): TabPin {
  // Created on first use rather than up front: building the tools must not
  // launch a browser (BX_TOOL_NAMES builds a throwaway set at import time).
  let pending: Promise<number | undefined> | null = null;
  let home: number | undefined;
  let current: number | undefined; // home, or the popup the model switched to
  const adopted = new Set<number>();
  return {
    async tab(): Promise<number | undefined> {
      if (pending === null) {
        // background: an agent's tab must never displace the operator's.
        pending = call<TabsResult>(profile, {
          cmd: "tabNew",
          url: startUrl,
          background: true,
        }).then((res) => {
          home = res.ok ? res.data.created?.id : undefined;
          current ??= home;
          return home;
        });
      }
      await pending;
      return current;
    },
    homeId: () => home,
    owned: () => [...(home === undefined ? [] : [home]), ...adopted],
    adopt(id: number): void {
      if (id !== home) adopted.add(id);
    },
    switchTo(id: number): void {
      current = id;
    },
    release(id: number): void {
      adopted.delete(id);
      if (current === id) current = home;
    },
    async close(): Promise<void> {
      if (pending === null) return;
      await pending;
      // The daemon may already be gone; call() reports that instead of throwing.
      for (const tab of [...adopted]) await call<TabsResult>(profile, { cmd: "tabClose", tab });
      if (home !== undefined) await call<TabsResult>(profile, { cmd: "tabClose", tab: home });
    },
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TARGET_DESC =
  'element to act on: a ref number from the element list ("3"), a data-testid or visible text ("Save changes"), or a CSS selector ("#email")';

const THEN_DESC =
  'fold the follow-up observation into this call: "els" returns the element list after the action (use it when the action opens or changes a view you will act in next), "text" returns the page text';

const CANVAS_DESC =
  "Canvas and game UIs only — anything with a DOM element must use bx_click. Without `in`, x/y are viewport coordinates.";

const IN_DESC =
  "element the coordinates are relative to (its top-left is 0,0), e.g. a canvas testid";

const thenParam = z.enum(["els", "text"]).optional().describe(THEN_DESC);

/**
 * Where this run's tab has got to. The driver hands the URL to the next rung so
 * an escalation opens where the previous attempt ended instead of about:blank.
 */
interface UrlTracker {
  note(url: string): void;
  last(): string | undefined;
}

function createUrlTracker(initial: string | undefined): UrlTracker {
  let url = initial;
  return {
    note(next: string): void {
      // about:blank is the absence of a page, not a place to resume from.
      if (!next.startsWith("about:")) url = next;
    },
    last: () => url,
  };
}

/** Tabs that have had a full scan: later bx_els calls on them send only the diff. */
type ScanState = Set<number>;

interface BuildOptions {
  vision: boolean;
}

function buildTools(
  profile: string,
  sink: ToolSink,
  pin: TabPin,
  track: UrlTracker,
  scanned: ScanState,
  build: BuildOptions,
) {
  /** Shared rendering for every command that returns an ActionResult. */
  const acted = (res: CmdResult<ActionResult>, done: string): ToolResult => {
    if (!res.ok) return say(renderError(res.error));
    const r = res.data;
    // Every ActionResult names the page it landed on; that is the cheapest
    // place to keep the tracker current.
    track.note(r.page.url);
    if (r.delta?.newTab !== undefined) pin.adopt(r.delta.newTab.id);
    const lines = [`ok — ${done}`, ...deltaLines(r)];
    if (r.consoleErrors.length > 0) lines.push(`console errors: ${r.consoleErrors.join(" | ")}`);
    const then = r.then;
    if (then?.els !== undefined) {
      scanned.add(r.page.id);
      lines.push("", renderEls(then.els));
    }
    if (then?.text !== undefined) lines.push("", renderText(then.text));
    if (then?.snap !== undefined) lines.push(`screenshot saved: ${then.snap.path}`);
    return say(lines.join("\n"));
  };

  const snapDesc = build.vision
    ? "Take a screenshot and SEE it (JPEG). For canvas/game pages whose state is not in the DOM. Costs image tokens — for DOM pages prefer bx_els/bx_text. There is no bx_snapshot tool; this is it."
    : "Save a screenshot to disk. Returns the file path — you cannot see the image. To see the page's structure use bx_els; to read it use bx_text. There is no bx_snapshot tool.";

  return [
    tool(
      "bx_open",
      "Navigate this tab to a URL and return the page title plus the interactive elements found there.",
      { url: z.string().describe("absolute URL, or a path if a base URL is already loaded") },
      async (args) => {
        const tab = await pin.tab();
        const res = await call<OpenResult>(profile, { cmd: "open", url: args.url, tab });
        if (!res.ok) return say(renderError(res.error));
        const { page, els, redirectedTo } = res.data;
        track.note(page.url);
        scanned.add(page.id);
        const redirect = redirectedTo === undefined ? "" : ` (redirected to ${redirectedTo})`;
        return say(`${page.title} — ${page.url}${redirect}\n${renderEls(els)}`);
      },
    ),

    tool(
      "bx_els",
      "List the interactive elements with ref numbers. After your first scan of a tab this returns only what changed since the previous scan; refs you already have stay valid until their element leaves the page. Pass full:true to get the whole list again.",
      {
        filter: z.string().optional().describe("only elements whose text matches this substring"),
        full: z.boolean().optional().describe("the whole list, not just the changes"),
        clickables: z
          .boolean()
          .optional()
          .describe("also list clickable elements that have no role (div/span click handlers)"),
      },
      async (args) => {
        const tab = await pin.tab();
        const diff = tab !== undefined && scanned.has(tab) && args.full !== true && args.filter === undefined;
        const res = await call<ElsResult>(profile, {
          cmd: "els",
          filter: args.filter,
          clickables: args.clickables,
          diff: diff ? true : undefined,
          tab,
        });
        if (!res.ok) return say(renderError(res.error));
        if (tab !== undefined && args.filter === undefined) scanned.add(tab);
        return say(renderEls(res.data));
      },
    ),

    tool(
      "bx_click",
      "Click an element. The result says what changed (navigation, dialog, alerts, focus, new tab).",
      { target: z.string().describe(TARGET_DESC), then: thenParam },
      async (args) => {
        const t = toTarget(args.target);
        if (!t.ok) return say(`error (bad_request): ${t.message}`);
        const tab = await pin.tab();
        const res = await call<ActionResult>(profile, {
          cmd: "click",
          target: t.target,
          then: args.then,
          tab,
        });
        return acted(res, `clicked ${args.target}`);
      },
    ),

    tool(
      "bx_fill",
      "Type a value into an input, textarea, or contenteditable, replacing what is there. Targeting a label or a wrapper works: its single input is used.",
      { target: z.string().describe(TARGET_DESC), value: z.string(), then: thenParam },
      async (args) => {
        const t = toTarget(args.target);
        if (!t.ok) return say(`error (bad_request): ${t.message}`);
        const tab = await pin.tab();
        const res = await call<ActionResult>(profile, {
          cmd: "fill",
          target: t.target,
          value: args.value,
          then: args.then,
          tab,
        });
        return acted(res, `filled ${args.target} with "${args.value}"`);
      },
    ),

    tool(
      "bx_select",
      "Choose an option by its value or visible label — works on a native <select> and on custom dropdowns (role=combobox/listbox): pass the dropdown as target and the option's label as value, no need to click it open first.",
      { target: z.string().describe(TARGET_DESC), value: z.string(), then: thenParam },
      async (args) => {
        const t = toTarget(args.target);
        if (!t.ok) return say(`error (bad_request): ${t.message}`);
        const tab = await pin.tab();
        const res = await call<ActionResult>(profile, {
          cmd: "select",
          target: t.target,
          value: args.value,
          then: args.then,
          tab,
        });
        return acted(res, `selected "${args.value}" in ${args.target}`);
      },
    ),

    tool(
      "bx_press",
      "Press a key on the focused element.",
      { key: z.string().describe('e.g. "Enter", "Tab", "Escape", "Control+a"'), then: thenParam },
      async (args) => {
        const tab = await pin.tab();
        const res = await call<ActionResult>(profile, {
          cmd: "press",
          key: args.key,
          then: args.then,
          tab,
        });
        return acted(res, `pressed ${args.key}`);
      },
    ),

    tool(
      "bx_scroll",
      "Scroll the page. Pass target to scroll that element into view, or deltaY to scroll by pixels (positive = down, e.g. 800 ≈ one screen). Use it for long or lazy-loading lists: scroll, then bx_els shows what appeared.",
      {
        deltaY: z.number().optional().describe("pixels to scroll; positive is down"),
        target: z.string().optional().describe(`${TARGET_DESC}; scrolled into view`),
        then: thenParam,
      },
      async (args) => {
        if (args.deltaY === undefined && args.target === undefined) {
          return say("error (bad_request): pass deltaY, target, or both");
        }
        const t = args.target === undefined ? undefined : toTarget(args.target);
        if (t && !t.ok) return say(`error (bad_request): ${t.message}`);
        const tab = await pin.tab();
        const res = await call<ActionResult>(profile, {
          cmd: "wheel",
          deltaY: args.deltaY ?? 0,
          in: t?.ok ? t.target : undefined,
          then: args.then,
          tab,
        });
        const what =
          args.target === undefined
            ? `scrolled ${args.deltaY}px`
            : `scrolled ${args.target} into view${args.deltaY ? ` then ${args.deltaY}px` : ""}`;
        return acted(res, what);
      },
    ),

    tool(
      "bx_wait",
      `Wait for a condition — pass exactly one: text (appears), gone (a target disappears), url (contains), js (expression becomes truthy), idle (network and DOM quiet), selector (becomes visible). ms is a fixed sleep capped at ${WAIT_MS_MAX}; prefer a condition. There is no separate "wait" tool; this is it.`,
      {
        text: z.string().optional(),
        gone: z.string().optional().describe(TARGET_DESC),
        url: z.string().optional().describe("substring the URL must contain"),
        js: z.string().optional().describe("JS expression polled until truthy"),
        idle: z.boolean().optional(),
        selector: z.string().optional(),
        ms: z.number().optional(),
        timeoutMs: z.number().optional().describe("default 5000"),
      },
      async (args) => {
        const given = [args.text, args.gone, args.url, args.js, args.idle, args.selector, args.ms].filter(
          (v) => v !== undefined,
        );
        if (given.length !== 1) {
          return say("error (bad_request): pass exactly one of text, gone, url, js, idle, selector, ms");
        }
        if (args.ms !== undefined && args.ms > WAIT_MS_MAX) {
          return say(
            `error (bad_request): fixed waits over ${WAIT_MS_MAX}ms are refused — wait for what you expect instead: text, gone, url, js or idle (each returns the moment it holds)`,
          );
        }
        const g = args.gone === undefined ? undefined : toTarget(args.gone);
        if (g && !g.ok) return say(`error (bad_request): ${g.message}`);
        const tab = await pin.tab();
        const res = await call<ActionResult>(profile, {
          cmd: "wait",
          text: args.text,
          gone: g?.ok ? g.target : undefined,
          url: args.url,
          js: args.js,
          idle: args.idle,
          selector: args.selector,
          ms: args.ms,
          timeoutMs: args.timeoutMs,
          tab,
        });
        const what =
          args.text !== undefined
            ? `text "${args.text}" is visible`
            : args.gone !== undefined
              ? `${args.gone} is gone`
              : args.url !== undefined
                ? `url contains ${args.url}`
                : args.js !== undefined
                  ? `${args.js} is truthy`
                  : args.idle !== undefined
                    ? "page is idle"
                    : args.selector !== undefined
                      ? `${args.selector} is visible`
                      : `waited ${args.ms}ms`;
        return acted(res, what);
      },
    ),

    tool(
      "bx_mouse",
      `Mouse action at a coordinate. ${CANVAS_DESC}`,
      {
        action: z.enum(["click", "dblclick", "move", "down", "up"]),
        x: z.number(),
        y: z.number(),
        in: z.string().optional().describe(IN_DESC),
        button: z.enum(["left", "right", "middle"]).optional(),
      },
      async (args) => {
        const t = args.in === undefined ? undefined : toTarget(args.in);
        if (t && !t.ok) return say(`error (bad_request): ${t.message}`);
        const tab = await pin.tab();
        const res = await call<ActionResult>(profile, {
          cmd: "mouse",
          action: args.action,
          x: args.x,
          y: args.y,
          in: t?.ok ? t.target : undefined,
          button: args.button,
          tab,
        });
        const where = args.in === undefined ? "" : ` in ${args.in}`;
        return acted(res, `mouse ${args.action} at ${args.x},${args.y}${where}`);
      },
    ),

    tool(
      "bx_drag",
      `Press at one coordinate, move, release at another. ${CANVAS_DESC}`,
      {
        fromX: z.number(),
        fromY: z.number(),
        toX: z.number(),
        toY: z.number(),
        in: z.string().optional().describe(IN_DESC),
        steps: z.number().optional().describe("intermediate moves, default 10"),
        mode: z
          .enum(["mouse", "pointer"])
          .optional()
          .describe(
            'use "pointer" when a mouse drag reports success but nothing moved — touch-none / pointer-capture DnD only sees pointer events',
          ),
      },
      async (args) => {
        const t = args.in === undefined ? undefined : toTarget(args.in);
        if (t && !t.ok) return say(`error (bad_request): ${t.message}`);
        const tab = await pin.tab();
        const res = await call<ActionResult>(profile, {
          cmd: "drag",
          fromX: args.fromX,
          fromY: args.fromY,
          toX: args.toX,
          toY: args.toY,
          in: t?.ok ? t.target : undefined,
          steps: args.steps,
          mode: args.mode,
          tab,
        });
        const where = args.in === undefined ? "" : ` in ${args.in}`;
        return acted(
          res,
          `dragged ${args.fromX},${args.fromY} → ${args.toX},${args.toY}${where}`,
        );
      },
    ),

    tool(
      "bx_key",
      "Hold a key down or release it — for held movement keys in games (w, a, s, d, ArrowLeft). Use bx_press for one-shot keys.",
      { action: z.enum(["down", "up"]), key: z.string() },
      async (args) => {
        const tab = await pin.tab();
        const res = await call<ActionResult>(profile, {
          cmd: "key",
          action: args.action,
          key: args.key,
          tab,
        });
        return acted(res, `key ${args.action} ${args.key}`);
      },
    ),

    tool(
      "bx_drive",
      "Install a JS controller in the page, then poll a predicate until truthy — entirely in-page, zero turns while it runs. THE way to drive a real-time game: write a controller (e.g. set the app's per-frame input hook), pass the win signal as `until`. Before authoring, dump ONE sample of the FULL input shape the hook accepts — buttons AND axes; a joystick-only controller cannot win a game whose jump/flap is a button. On timeout, revise the controller and call bx_drive again — the new install replaces the old; the game keeps running.",
      {
        install: z.string().describe("JS statements run once, e.g. set the per-frame input hook"),
        until: z
          .string()
          .describe("JS expression polled until truthy, e.g. window.__play.runner.status === 'won'"),
        timeoutMs: z.number().optional().describe("default 15000"),
        pollMs: z.number().optional().describe("default 500"),
      },
      async (args) => {
        const tab = await pin.tab();
        const res = await call<DriveResult>(profile, {
          cmd: "drive",
          install: args.install,
          until: args.until,
          timeoutMs: args.timeoutMs,
          pollMs: args.pollMs,
          tab,
        });
        if (!res.ok) return say(renderError(res.error));
        const { satisfied, elapsedMs, polls, finalValue, page } = res.data;
        track.note(page.url);
        // A drive that timed out is a result to iterate on, not an error.
        return say(
          `${satisfied ? "satisfied" : "NOT satisfied"} after ${elapsedMs}ms (${polls} polls) — last value: ${finalValue}`,
        );
      },
    ),

    tool("bx_back", "Go back one entry in history.", {}, async () => {
      const tab = await pin.tab();
      const res = await call<ActionResult>(profile, { cmd: "back", tab });
      return acted(res, "went back");
    }),

    tool("bx_reload", "Reload the current page.", {}, async () => {
      const tab = await pin.tab();
      const res = await call<ActionResult>(profile, { cmd: "reload", tab });
      return acted(res, "reloaded");
    }),

    tool(
      "bx_tabs",
      "Tabs this run owns: your home tab plus any popup or new tab an action opened. list shows them; switch moves all later commands to that tab; close closes a popup (your commands return to the home tab).",
      {
        action: z.enum(["list", "switch", "close"]),
        id: z.number().int().optional().describe("tab id from list or from an action's 'opened new tab'"),
      },
      async (args) => {
        const current = await pin.tab();
        const home = pin.homeId();
        const res = await call<TabsResult>(profile, { cmd: "tabs" });
        if (!res.ok) return say(renderError(res.error));
        // A popup the daemon did not report (no delta yet) is still a tab that
        // appeared after ours: ids are monotonic, so newer means "since we began".
        const owned = new Set(pin.owned());
        const mine = res.data.pages.filter(
          (p) => owned.has(p.id) || (home !== undefined && p.id > home),
        );
        const describe = (p: PageInfo): string =>
          `[${p.id}]${p.id === current ? " (current)" : ""}${p.id === home ? " (home)" : ""} ${p.title || "(untitled)"} — ${p.url}`;
        if (args.action === "list") {
          return say(mine.length === 0 ? "(no tabs)" : mine.map(describe).join("\n"));
        }
        if (args.id === undefined) return say(`error (bad_request): ${args.action} needs an id`);
        const target = mine.find((p) => p.id === args.id);
        if (target === undefined) {
          return say(`error (no_page): tab ${args.id} is not one of yours — bx_tabs list shows them`);
        }
        if (args.action === "switch") {
          pin.adopt(target.id);
          pin.switchTo(target.id);
          track.note(target.url);
          return say(`ok — now working in tab ${target.id}: ${target.title || "(untitled)"} — ${target.url}`);
        }
        if (target.id === home) return say("error (bad_request): your home tab closes itself when you finish");
        const closed = await call<TabsResult>(profile, { cmd: "tabClose", tab: target.id });
        if (!closed.ok) return say(renderError(closed.error));
        pin.release(target.id);
        return say(`ok — closed tab ${target.id}; working in tab ${await pin.tab()}`);
      },
    ),

    tool(
      "bx_expect",
      "Assert something about the page. Returns PASS or FAIL — it never errors, so use it freely to verify outcomes.",
      {
        kind: z.enum(["text", "url", "visible", "notVisible"]),
        value: z
          .string()
          .describe("text to find, URL substring, or the target for visible/notVisible"),
      },
      async (args) => {
        const tab = await pin.tab();
        const res = await call<ExpectResult>(profile, {
          cmd: "expect",
          kind: args.kind,
          value: args.value,
          tab,
        });
        // An assertion the daemon could not evaluate is a failed assertion as
        // far as the model is concerned — same PASS/FAIL contract either way.
        if (!res.ok) return say(`FAIL: ${res.error.message}`);
        return say(`${res.data.pass ? "PASS" : "FAIL"}: ${res.data.detail}`);
      },
    ),

    tool(
      "bx_text",
      "Read the page's main content as compact markdown (headings, lists, links), or one element's text.",
      {
        target: z.string().optional().describe(`${TARGET_DESC}; omit for the main content`),
        plain: z.boolean().optional().describe("plain text instead of markdown"),
      },
      async (args) => {
        const t = args.target === undefined ? undefined : toTarget(args.target);
        if (t && !t.ok) return say(`error (bad_request): ${t.message}`);
        const tab = await pin.tab();
        const res = await call<TextResult>(profile, {
          cmd: "text",
          target: t?.ok ? t.target : undefined,
          md: args.plain === true ? undefined : true,
          tab,
        });
        return res.ok ? say(renderText(res.data)) : say(renderError(res.error));
      },
    ),

    tool(
      "bx_js",
      "Evaluate JavaScript in the page and return the value as JSON — an expression, or statements whose last expression is the result. For READING state the app exposes (e.g. window.__game.player) — never for clicking or mutating; use the action tools for that. There is no separate js or bash tool; this is the only code you can run.",
      { expression: z.string().describe("e.g. window.__game.targets.length") },
      async (args) => {
        const tab = await pin.tab();
        const res = await call<JsResult>(profile, { cmd: "js", expression: args.expression, tab });
        if (!res.ok) return say(renderError(res.error));
        return say(res.data.truncated ? `${res.data.value}\n…(truncated)` : res.data.value);
      },
    ),

    tool("bx_console", "Show this tab's recent console errors and warnings.", {}, async () => {
      const tab = await pin.tab();
      const res = await call<ConsoleEntry[]>(profile, { cmd: "console", tab });
      if (!res.ok) return say(renderError(res.error));
      const entries = Array.isArray(res.data) ? res.data : [];
      if (entries.length === 0) return say("(no console errors)");
      return say(entries.map((e) => `${e.level}: ${e.text}`).join("\n"));
    }),

    tool(
      "bx_snap",
      snapDesc,
      { target: z.string().optional().describe(`${TARGET_DESC}; crops to that element`) },
      async (args) => {
        const t = args.target === undefined ? undefined : toTarget(args.target);
        if (t && !t.ok) return say(`error (bad_request): ${t.message}`);
        const tab = await pin.tab();
        const res = await call<SnapResult>(profile, {
          cmd: "snap",
          target: t?.ok ? t.target : undefined,
          tab,
          ...(build.vision ? { jpeg: true, quality: VISION_JPEG_QUALITY } : {}),
        });
        if (!res.ok) return say(renderError(res.error));
        if (!build.vision) return say(`screenshot saved: ${res.data.path}`);
        try {
          const bytes = await readFile(res.data.path);
          // The daemon may predate jpeg output; trust the file over the request.
          const jpeg = res.data.format === "jpeg" || /\.jpe?g$/i.test(res.data.path);
          return {
            content: [
              { type: "image", data: bytes.toString("base64"), mimeType: jpeg ? "image/jpeg" : "image/png" },
              { type: "text", text: `${res.data.width}x${res.data.height} — ${res.data.path}` },
            ],
          };
        } catch (e: unknown) {
          return say(`screenshot saved to ${res.data.path} but could not be read: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    ),

    tool(
      "bx_report",
      "Report the final outcome of the task. Call this exactly once, then stop.",
      {
        status: z.enum(["pass", "fail"]),
        summary: z.string().describe("2–3 sentences on what you did and what you observed"),
        evidence: z
          .array(z.string())
          .describe("assertions that passed, the final URL, screenshot paths"),
      },
      async (args) => {
        sink.setReport({ status: args.status, summary: args.summary, evidence: args.evidence });
        return say("report recorded — you are done, stop now.");
      },
    ),
  ];
}

/**
 * Fully-qualified names for the driver's allowedTools. Derived from the real
 * definitions (buildTools only creates closures, so calling it here is free)
 * so the allowlist cannot drift out of sync with the tools that exist.
 */
export const BX_TOOL_NAMES: string[] = buildTools(
  "",
  { setReport() {} },
  createTabPin(""),
  createUrlTracker(undefined),
  new Set(),
  { vision: false },
).map((t) => `mcp__${BX_SERVER_NAME}__${t.name}`);

/** The MCP server plus the lifecycle of the tabs its tools are pinned to. */
export interface BxTools {
  server: ReturnType<typeof createSdkMcpServer>;
  /** Releases this run's tabs. Safe to call more than once, and never throws. */
  close(): Promise<void>;
  /** The last page this run reached — a start URL for the rung after it. */
  lastUrl(): string | undefined;
  /** Every tab this run drove (home first); what scopes the shared action log to this run. */
  tabIds(): number[];
  /** Evaluates JS in this run's current tab — the driver's own channel for --enter and --win. */
  runJs(expression: string): Promise<{ ok: boolean; value: string }>;
  /** A full element scan of the current tab, as the model would see it; later bx_els calls send diffs. */
  scan(): Promise<string>;
}

export interface BxToolsOptions {
  /** Open this run's home tab here instead of about:blank. */
  startUrl?: string;
  /** bx_snap returns the image itself (G5). */
  vision?: boolean;
}

export function createBxTools(profile: string, sink: ToolSink, opts: BxToolsOptions = {}): BxTools {
  const pin = createTabPin(profile, opts.startUrl);
  const track = createUrlTracker(opts.startUrl);
  const scanned: ScanState = new Set();
  return {
    server: createSdkMcpServer({
      name: BX_SERVER_NAME,
      version: "0.2.0",
      tools: buildTools(profile, sink, pin, track, scanned, { vision: opts.vision === true }),
      // The driver has one job and a handful of tools; deferring them behind
      // tool search would cost a round trip for no benefit.
      alwaysLoad: true,
    }),
    close: () => pin.close(),
    lastUrl: () => track.last(),
    tabIds: () => pin.owned(),
    async runJs(expression: string): Promise<{ ok: boolean; value: string }> {
      const tab = await pin.tab();
      const res = await call<JsResult>(profile, { cmd: "js", expression, tab });
      return res.ok ? { ok: true, value: res.data.value } : { ok: false, value: res.error.message };
    },
    async scan(): Promise<string> {
      const tab = await pin.tab();
      const res = await call<ElsResult>(profile, { cmd: "els", tab });
      if (!res.ok) return renderError(res.error);
      if (tab !== undefined) scanned.add(tab);
      return renderEls(res.data);
    },
  };
}
