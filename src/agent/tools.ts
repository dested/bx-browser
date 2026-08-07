// bx verbs exposed to the driver model as in-process MCP tools.
//
// Two rules govern every handler here:
//   1. Never throw. A thrown tool error reads as a dead end to a small model;
//      the same information as text ("not found — did you mean [4] …") is
//      something it can act on. Failures are returned, not raised.
//   2. Never return an image. The driver model is text-only by design, so
//      bx_snap yields a path and nothing else.

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
  ElsResult,
  ExpectResult,
  JsResult,
  OpenResult,
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

// ---------------------------------------------------------------------------
// Result plumbing
// ---------------------------------------------------------------------------

type ToolResult = { content: Array<{ type: "text"; text: string }> };

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
  const lines = near.map((e) => `did you mean: [${e.ref}] ${e.role} "${e.name}"`);
  return [`error (${err.code}): ${err.message}`, ...lines].join("\n");
}

/** Shared rendering for every command that returns an ActionResult. */
function renderAction(res: CmdResult<ActionResult>, done: string): ToolResult {
  if (!res.ok) return say(renderError(res.error));
  const { page, navigated, consoleErrors } = res.data;
  const lines = [`ok — ${done}`];
  if (navigated) lines.push(`now at ${page.url} — ${page.title}`);
  if (consoleErrors.length > 0) lines.push(`console errors: ${consoleErrors.join(" | ")}`);
  return say(lines.join("\n"));
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
 * One browser tab per tools instance. Every run gets its own page and pins each
 * command to it, so concurrent runs against one daemon cannot navigate, scan,
 * or click in each other's page.
 */
interface TabPin {
  /** This instance's tab id; undefined only when the daemon could not make one. */
  tab(): Promise<number | undefined>;
  close(): Promise<void>;
}

function createTabPin(profile: string): TabPin {
  // Created on first use rather than up front: building the tools must not
  // launch a browser (BX_TOOL_NAMES builds a throwaway set at import time).
  let pending: Promise<number | undefined> | null = null;
  return {
    tab(): Promise<number | undefined> {
      if (pending === null) {
        pending = call<TabsResult>(profile, { cmd: "tabNew" }).then((res) =>
          res.ok ? res.data.created?.id : undefined,
        );
      }
      return pending;
    },
    async close(): Promise<void> {
      if (pending === null) return;
      const tab = await pending;
      if (tab === undefined) return;
      // The daemon may already be gone; call() reports that instead of throwing.
      await call<TabsResult>(profile, { cmd: "tabClose", tab });
    },
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TARGET_DESC =
  'element to act on: a ref number from the element list ("3"), a data-testid or visible text ("Save changes"), or a CSS selector ("#email")';

const CANVAS_DESC =
  "Canvas and game UIs only — anything with a DOM element must use bx_click. Without `in`, x/y are viewport coordinates.";

const IN_DESC =
  "element the coordinates are relative to (its top-left is 0,0), e.g. a canvas testid";

function buildTools(profile: string, sink: ToolSink, pin: TabPin) {
  return [
    tool(
      "bx_open",
      "Navigate to a URL and return the page title plus the interactive elements found there.",
      { url: z.string().describe("absolute URL, or a path if a base URL is already loaded") },
      async (args) => {
        const tab = await pin.tab();
        const res = await call<OpenResult>(profile, { cmd: "open", url: args.url, tab });
        if (!res.ok) return say(renderError(res.error));
        const { page, els } = res.data;
        return say(`${page.title} — ${page.url}\n${els.rendered}`);
      },
    ),

    tool(
      "bx_els",
      "List the interactive elements on the current page with fresh ref numbers.",
      { filter: z.string().optional().describe("only elements whose text matches this substring") },
      async (args) => {
        const tab = await pin.tab();
        const res = await call<ElsResult>(profile, { cmd: "els", filter: args.filter, tab });
        return res.ok ? say(res.data.rendered) : say(renderError(res.error));
      },
    ),

    tool(
      "bx_click",
      "Click an element.",
      { target: z.string().describe(TARGET_DESC) },
      async (args) => {
        const t = toTarget(args.target);
        if (!t.ok) return say(`error (bad_request): ${t.message}`);
        const tab = await pin.tab();
        const res = await call<ActionResult>(profile, { cmd: "click", target: t.target, tab });
        return renderAction(res, `clicked ${args.target}`);
      },
    ),

    tool(
      "bx_fill",
      "Type a value into an input, textarea, or contenteditable, replacing what is there.",
      { target: z.string().describe(TARGET_DESC), value: z.string() },
      async (args) => {
        const t = toTarget(args.target);
        if (!t.ok) return say(`error (bad_request): ${t.message}`);
        const tab = await pin.tab();
        const res = await call<ActionResult>(profile, {
          cmd: "fill",
          target: t.target,
          value: args.value,
          tab,
        });
        return renderAction(res, `filled ${args.target} with "${args.value}"`);
      },
    ),

    tool(
      "bx_select",
      "Choose an option in a <select> by its value or its visible label.",
      { target: z.string().describe(TARGET_DESC), value: z.string() },
      async (args) => {
        const t = toTarget(args.target);
        if (!t.ok) return say(`error (bad_request): ${t.message}`);
        const tab = await pin.tab();
        const res = await call<ActionResult>(profile, {
          cmd: "select",
          target: t.target,
          value: args.value,
          tab,
        });
        return renderAction(res, `selected "${args.value}" in ${args.target}`);
      },
    ),

    tool(
      "bx_press",
      "Press a key on the focused element.",
      { key: z.string().describe('e.g. "Enter", "Tab", "Escape", "Control+a"') },
      async (args) => {
        const tab = await pin.tab();
        const res = await call<ActionResult>(profile, { cmd: "press", key: args.key, tab });
        return renderAction(res, `pressed ${args.key}`);
      },
    ),

    tool(
      "bx_wait",
      "Wait for text to appear, a selector to become visible, or a fixed number of milliseconds. Pass exactly one.",
      {
        text: z.string().optional(),
        selector: z.string().optional(),
        ms: z.number().optional(),
      },
      async (args) => {
        const given = [args.text, args.selector, args.ms].filter((v) => v !== undefined);
        if (given.length !== 1) {
          return say("error (bad_request): pass exactly one of text, selector, or ms");
        }
        const tab = await pin.tab();
        const res = await call<ActionResult>(profile, {
          cmd: "wait",
          text: args.text,
          selector: args.selector,
          ms: args.ms,
          tab,
        });
        const what =
          args.text !== undefined
            ? `waited for text "${args.text}"`
            : args.selector !== undefined
              ? `waited for ${args.selector}`
              : `waited ${args.ms}ms`;
        return renderAction(res, what);
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
        return renderAction(res, `mouse ${args.action} at ${args.x},${args.y}${where}`);
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
          tab,
        });
        const where = args.in === undefined ? "" : ` in ${args.in}`;
        return renderAction(
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
        return renderAction(res, `key ${args.action} ${args.key}`);
      },
    ),

    tool("bx_back", "Go back one entry in history.", {}, async () => {
      const tab = await pin.tab();
      const res = await call<ActionResult>(profile, { cmd: "back", tab });
      return renderAction(res, "went back");
    }),

    tool("bx_reload", "Reload the current page.", {}, async () => {
      const tab = await pin.tab();
      const res = await call<ActionResult>(profile, { cmd: "reload", tab });
      return renderAction(res, "reloaded");
    }),

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
      "Read the visible text of the page, or of one element.",
      { selector: z.string().optional().describe("CSS selector; omit for the whole page") },
      async (args) => {
        const tab = await pin.tab();
        const res = await call<TextResult>(profile, { cmd: "text", selector: args.selector, tab });
        if (!res.ok) return say(renderError(res.error));
        return say(res.data.truncated ? `${res.data.text}\n…(truncated)` : res.data.text);
      },
    ),

    tool(
      "bx_js",
      "Evaluate a JavaScript expression in the page and return its value as JSON. For READING state the app exposes (e.g. window.__game.player) — never for clicking or mutating; use the action tools for that.",
      { expression: z.string().describe("a single JS expression, e.g. window.__game.targets.length") },
      async (args) => {
        const tab = await pin.tab();
        const res = await call<JsResult>(profile, { cmd: "js", expression: args.expression, tab });
        if (!res.ok) return say(renderError(res.error));
        return say(res.data.truncated ? `${res.data.value}\n…(truncated)` : res.data.value);
      },
    ),

    tool("bx_console", "Show recent console errors and warnings.", {}, async () => {
      const res = await call<ConsoleEntry[]>(profile, { cmd: "console" });
      if (!res.ok) return say(renderError(res.error));
      const entries = Array.isArray(res.data) ? res.data : [];
      if (entries.length === 0) return say("(no console errors)");
      return say(entries.map((e) => `${e.level}: ${e.text}`).join("\n"));
    }),

    tool("bx_snap", "Save a screenshot. Returns the file path — you cannot see the image.", {}, async () => {
      const tab = await pin.tab();
      const res = await call<SnapResult>(profile, { cmd: "snap", tab });
      return res.ok ? say(`screenshot saved: ${res.data.path}`) : say(renderError(res.error));
    }),

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
).map((t) => `mcp__${BX_SERVER_NAME}__${t.name}`);

/** The MCP server plus the lifecycle of the tab its tools are pinned to. */
export interface BxTools {
  server: ReturnType<typeof createSdkMcpServer>;
  /** Releases this run's tab. Safe to call more than once, and never throws. */
  close(): Promise<void>;
}

export function createBxTools(profile: string, sink: ToolSink): BxTools {
  const pin = createTabPin(profile);
  return {
    server: createSdkMcpServer({
      name: BX_SERVER_NAME,
      version: "0.1.0",
      tools: buildTools(profile, sink, pin),
      // The driver has one job and a handful of tools; deferring them behind
      // tool search would cost a round trip for no benefit.
      alwaysLoad: true,
    }),
    close: () => pin.close(),
  };
}
