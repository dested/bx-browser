#!/usr/bin/env bun
// bx — browser automation for Claude Code. Hand-rolled argv parsing: the whole
// point is a tiny, predictable surface with no dependency weight.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CliError,
  cmd,
  formatAction,
  formatConsoleEntry,
  formatNetEntry,
  isAlive,
  isSelectorLike,
  listProfiles,
  parseTarget,
  readRunFile,
  renderEl,
  renderPage,
  stopDaemon,
} from "./client.ts";
import { runFlow } from "./flows/runner.ts";
import type {
  ActionResult,
  AgentModel,
  AgentReport,
  AgentRunOptions,
  BxError,
  Cmd,
  CmdResult,
  ConsoleEntry,
  DriveResult,
  ElsResult,
  ExpectResult,
  JsResult,
  NetEntry,
  OpenResult,
  RecordStartResult,
  RecordStopResult,
  SnapResult,
  StatusResult,
  TabsResult,
  Target,
  TextResult,
} from "./protocol.ts";

const USAGE = `bx — browser automation for Claude Code

Usage: bx [--profile <name>] [--headless] [--json] <command> [args]

Navigation
  open <url>                       open a url, then print its interactive elements
  back                             go back in history
  reload                           reload the current page
  tabs                             list open tabs
  tab <n>                          switch to tab n
  tab new [url]                    open a new tab
  tab close                        close the active tab

Observation
  els [--all] [--filter <text>]    interactive elements as [ref] role "name"
  text [selector]                  visible text of the page, or of one selector
  snap [path] [--full]             screenshot, downscaled; --full for whole page
  console [--all] [--filter <re>]  console entries (errors + warnings by default)
  net [--failed] [--filter <re>]   network requests
  js <expression>                  evaluate an expression in the page
  status                           daemon, browser, tabs and recording state

Interaction  (<target> = ref number | selector (#, ., [, //, css=, xpath=) | visible text)
  click <target>                   click an element
  fill <target> <value>            set an input's value
  press <key>                      press a key, e.g. Enter or Control+a
  select <target> <value>          choose an option in a <select>
  wait <ms | selector | text>      sleep, or wait for a selector or visible text
  expect <kind> <value>            assert; kind = text | url | visible | not-visible

Canvas / coordinates  (games and non-semantic UIs; with --in <target>, x and y
are relative to that element's top-left, otherwise to the viewport)
  mouse <action> <x> <y>           action = click | dblclick | move | down | up
                                   [--in <target>] [--button left|right|middle]
  drag <x1> <y1> <x2> <y2>         press, move and release [--in <target>]
                                   [--steps <n>] (default 10 intermediate moves)
                                   [--pointer] [--hold <ms>] [--step-delay <ms>]
                                   --pointer dispatches PointerEvents instead of
                                   mouse events, for touch-none / pointer-intent
                                   DnD that never sees a mouse
  key <down|up> <key>              hold or release a key, e.g. w — press is the
                                   one-shot version
  wheel <deltaY> [x y]             scroll; x y moves the pointer first
                                   [--in <target>]
  drive --install "<js>"           install an in-page controller and poll a
        --until "<expr>"           predicate to truthy — zero model tokens
                                   [--timeout <ms>] (default 15000)
                                   [--poll <ms>] (default 500)

Flows and automation
  run <flow.ts> [--record]         replay a typed flow file (zero model tokens)
  record start <slug>              start recording the session
  record stop                      stop and package it under recordings/<slug>/
  agent "<instruction>"            let a cheap model drive; prints a short report
                                   [--model haiku|sonnet|opus] [--opus]
                                   [--save <name>] [--max-turns <n>] [--verbose]
                                   [--budget <usd>] [--max-wall <s>]
                                   [--url <u>] [--enter <js>] [--win <expr>]
                                   --opus allows one final escalation to Opus 4.8
                                   — complex flows only, ~5× Sonnet cost
                                   --budget/--max-wall abort the run at that
                                   estimated spend or elapsed time and still
                                   print a report
                                   --url opens the agent's tab there; --enter
                                   <js> runs once before the first turn (kills
                                   entry discovery on canvas apps); --win <expr>
                                   is the success predicate — verified before a
                                   pass is accepted

Setup
  install-skill                    copy the bx skill into ~/.claude/skills/bx so
                                   Claude Code reaches for bx on its own

Daemon
  profiles                         list profiles and which are running
  stop                             shut this profile's daemon down
  help                             this text

Flags
  --profile <name>                 browser session to use (default: "default")
  --headless                       launch headless when starting the daemon
  --timeout <ms>                   override the 5000ms default on click, fill,
                                   select, wait and expect
  --json                           print raw JSON instead of text; exit code unchanged
  -h, --help                       this text, from anywhere in the command line

Output is token-budgeted at the source: els <= 100 elements / 3200 chars, text
<= 8000 chars, js <= 4000 chars, console and net <= 30 entries each.

Set BX_TIMING=1 to print each command's wall time to stderr; --json output
carries the same number as an "ms" field.

Exit codes: 0 ok | 1 command or assertion failed | 2 usage error | 3 daemon or
browser failure.
`;

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

interface Globals {
  profile: string;
  // undefined = the user did not ask; adopt whatever daemon is already running.
  headless: boolean | undefined;
  json: boolean;
}

// MSYS path conversion: Git Bash rewrites a bare `/foo` argument to
// `<EXEPATH>/foo` before bx ever sees it, corrupting urls, xpath targets and
// filters. Undo it by stripping that exact prefix back off — nothing else.
function repairMsysArgs(argv: string[]): string[] {
  const msystem = process.env.MSYSTEM;
  const exePath = process.env.EXEPATH;
  if (msystem === undefined || msystem === "" || exePath === undefined) return argv;
  const prefix = exePath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (prefix.length === 0) return argv;
  const marker = `${prefix.toLowerCase()}/`;
  return argv.map((arg) => {
    const normalized = arg.replace(/\\/g, "/");
    if (!normalized.toLowerCase().startsWith(marker)) return arg;
    return normalized.slice(prefix.length);
  });
}

function extractGlobals(argv: string[]): { globals: Globals; rest: string[] } {
  const rest: string[] = [];
  let profile = "default";
  let headless: boolean | undefined;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--profile") {
      const value = argv[i + 1];
      if (value === undefined) throw new CliError(2, "--profile needs a name");
      profile = value;
      i++;
      continue;
    }
    if (arg === "--headless") {
      headless = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    rest.push(arg);
  }
  return { globals: { profile, headless, json }, rest };
}

function takeFlag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

function takeOption(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (value === undefined) throw new CliError(2, `${name} needs a value`);
  args.splice(i, 2);
  return value;
}

function takeTimeout(args: string[]): number | undefined {
  const value = takeOption(args, "--timeout");
  if (value === undefined) return undefined;
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new CliError(2, "--timeout takes a positive number of milliseconds");
  }
  return ms;
}

function expectKind(kind: string): "text" | "url" | "visible" | "notVisible" {
  switch (kind) {
    case "text":
      return "text";
    case "url":
      return "url";
    case "visible":
      return "visible";
    case "not-visible":
      return "notVisible";
    default:
      throw new CliError(2, `unknown expect kind "${kind}" — use text | url | visible | not-visible`);
  }
}

type MouseAction = Extract<Cmd, { cmd: "mouse" }>["action"];
type MouseButton = NonNullable<Extract<Cmd, { cmd: "mouse" }>["button"]>;

function mouseAction(action: string | undefined): MouseAction {
  switch (action) {
    case "click":
    case "dblclick":
    case "move":
    case "down":
    case "up":
      return action;
    default:
      throw new CliError(2, "usage: bx mouse <click|dblclick|move|down|up> <x> <y>");
  }
}

function mouseButton(button: string | undefined): MouseButton | undefined {
  if (button === undefined) return undefined;
  if (button === "left" || button === "right" || button === "middle") return button;
  throw new CliError(2, `unknown button "${button}" — use left | right | middle`);
}

function coord(raw: string | undefined, usage: string): number {
  const n = Number(raw);
  if (raw === undefined || raw === "" || !Number.isFinite(n)) throw new CliError(2, usage);
  return n;
}

// `--in` is the element coordinates are measured from; absent means viewport.
// `where` is the printed suffix, kept alongside so both come from one parse.
function takeIn(args: string[]): { target: Target | undefined; where: string } {
  const raw = takeOption(args, "--in");
  if (raw === undefined) return { target: undefined, where: "" };
  return { target: parseTarget(raw), where: ` in ${q(raw)}` };
}

/** Millisecond knobs that are allowed to be 0 — "no pause" is a real answer. */
function takeDelayMs(args: string[], name: string): number | undefined {
  const value = takeOption(args, name);
  if (value === undefined) return undefined;
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms < 0) {
    throw new CliError(2, `${name} takes a whole number of milliseconds, 0 or more`);
  }
  return ms;
}

/** Millisecond knobs where 0 is meaningless — drive's timeout and poll cadence. */
function takePositiveMs(args: string[], name: string): number | undefined {
  const value = takeOption(args, name);
  if (value === undefined) return undefined;
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms <= 0) {
    throw new CliError(2, `${name} takes a positive whole number of milliseconds`);
  }
  return ms;
}

function takeMaxTurns(args: string[]): number | undefined {
  const value = takeOption(args, "--max-turns");
  if (value === undefined) return undefined;
  const turns = Number(value);
  if (!Number.isInteger(turns) || turns <= 0) {
    throw new CliError(2, "--max-turns takes a positive whole number of turns");
  }
  return turns;
}

function takeBudgetUsd(args: string[]): number | undefined {
  const value = takeOption(args, "--budget");
  if (value === undefined) return undefined;
  const usd = Number(value);
  if (!Number.isFinite(usd) || usd <= 0) {
    throw new CliError(2, "--budget takes a positive number of dollars, e.g. --budget 0.25");
  }
  return usd;
}

function takeMaxWallMs(args: string[]): number | undefined {
  const value = takeOption(args, "--max-wall");
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new CliError(2, "--max-wall takes a positive whole number of seconds");
  }
  return seconds * 1000;
}

function agentModel(model: string | undefined): AgentModel {
  if (model === undefined || model === "haiku") return "haiku";
  if (model === "sonnet") return "sonnet";
  if (model === "opus") return "opus";
  throw new CliError(2, `unknown model "${model}" — use haiku | sonnet | opus`);
}

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

function out(text: string): void {
  if (text.length > 0) process.stdout.write(`${text}\n`);
}

// Wall clock for one command: started once parsing is done, read again as each
// result is printed, so --json and BX_TIMING report the same number.
let startedAt = 0;

function elapsedMs(): number {
  return Math.round(performance.now() - startedAt);
}

// JSON payloads that are objects carry the timing inline; the list-shaped ones
// (console, net, profiles) stay arrays and print unchanged.
function printJson(value: unknown): void {
  const payload =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? { ...value, ms: elapsedMs() }
      : value;
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function reportTiming(): void {
  const flag = process.env.BX_TIMING;
  if (flag === undefined || flag === "" || flag === "0") return;
  process.stderr.write(`(${elapsedMs()}ms)\n`);
}

function exitCodeFor(code: BxError["code"]): number {
  if (code === "browser_launch_failed" || code === "internal") return 3;
  if (code === "bad_request") return 2;
  return 1;
}

function printError(error: BxError): void {
  process.stderr.write(`✗ ${error.code}: ${error.message}\n`);
  if (error.nearMatches && error.nearMatches.length > 0) {
    process.stderr.write("did you mean:\n");
    for (const el of error.nearMatches) process.stderr.write(`  ${renderEl(el)}\n`);
  }
}

function emit<T>(g: Globals, res: CmdResult<T>, render: (data: T) => string): number {
  if (g.json) {
    printJson(res.ok ? res.data : res.error);
    return res.ok ? 0 : exitCodeFor(res.error.code);
  }
  if (!res.ok) {
    printError(res.error);
    return exitCodeFor(res.error.code);
  }
  out(render(res.data));
  return 0;
}

async function send<T>(g: Globals, c: Cmd, render: (data: T) => string): Promise<number> {
  const res = await cmd<T>(g.profile, c, { headless: g.headless });
  return emit(g, res, render);
}

function q(s: string): string {
  return JSON.stringify(s);
}

// The tab verbs answer with the whole tab list, so confirm the change and then
// show the new state — that is what the next command needs to act on.
function renderTabChange(verb: string, detail: string): (data: TabsResult) => string {
  return (data) => {
    const head = `✓ ${verb} ${detail}`.trimEnd();
    return data.pages.length === 0 ? head : `${head}\n${data.pages.map(renderPage).join("\n")}`;
  };
}

function renderEls(data: ElsResult): string {
  const rendered = data.rendered.trim();
  if (rendered.length === 0) return "(no interactive elements)";
  return data.truncated ? `${rendered}\n…(${data.total} total, list truncated)` : rendered;
}

function renderEntries<T>(entries: T[], format: (entry: T) => string): string {
  if (entries.length === 0) return "(none)";
  return entries.map(format).join("\n");
}

function fmtDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`;
}

function renderStatus(s: StatusResult): string {
  const lines = [
    `profile   ${s.profile}${s.headless ? " (headless)" : ""}`,
    `browser   ${s.browserRunning ? `running, up ${fmtDuration(s.uptimeMs)}` : "not running"}`,
    `recording ${s.recording ?? "none"}`,
    `tabs      ${s.pages.length}`,
  ];
  for (const page of s.pages) lines.push(`  ${renderPage(page)}`);
  return lines.join("\n");
}

function renderReport(report: AgentReport): string {
  const lines = [report.status === "pass" ? "✓ PASS" : "✗ FAIL", report.summary];
  for (const item of report.evidence) lines.push(`  • ${item}`);
  if (report.savedFlow !== undefined) lines.push(`saved flow → ${report.savedFlow}`);
  const u = report.usage;
  // Anything other than a model-authored report is a run that was cut short —
  // say so on the trailer, not just inside the summary.
  const ended =
    report.endedBy === undefined || report.endedBy === "report" ? "" : ` ended=${report.endedBy}`;
  lines.push(
    `tier=${report.tier}${report.escalated ? " (escalated)" : ""}${ended} turns=${report.turns} ` +
      `wall=${(report.wallMs / 1000).toFixed(1)}s tokens=${u.inputTokens}/${u.outputTokens} ` +
      `(${u.cacheReadTokens} cached) cost=$${u.costUsd === null ? "n/a" : u.costUsd.toFixed(4)}` +
      // Both figures, always: on an aborted run the estimate includes the rung
      // the metered cost structurally cannot see.
      `${report.estUsd === undefined ? "" : ` est=$${report.estUsd.toFixed(2)}`}`,
  );
  if (report.transcriptPath !== undefined) lines.push(`  transcript ${report.transcriptPath}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function dispatch(g: Globals, command: string, args: string[]): Promise<number> {
  switch (command) {
    case "open": {
      const url = args[0];
      if (url === undefined) throw new CliError(2, "usage: bx open <url>");
      return send<OpenResult>(g, { cmd: "open", url }, (d) =>
        `✓ ${d.page.title || "(untitled)"} — ${d.page.url}\n\n${renderEls(d.els)}`,
      );
    }

    case "els": {
      const all = takeFlag(args, "--all");
      const filter = takeOption(args, "--filter");
      return send<ElsResult>(g, { cmd: "els", all, filter }, renderEls);
    }

    case "click": {
      const timeoutMs = takeTimeout(args);
      const target = args[0];
      if (target === undefined) throw new CliError(2, "usage: bx click <target>");
      return send<ActionResult>(
        g,
        { cmd: "click", target: parseTarget(target), timeoutMs },
        (d) => formatAction("clicked", q(target), d),
      );
    }

    case "fill": {
      const timeoutMs = takeTimeout(args);
      const target = args[0];
      const value = args[1];
      if (target === undefined || value === undefined) {
        throw new CliError(2, "usage: bx fill <target> <value>");
      }
      return send<ActionResult>(
        g,
        { cmd: "fill", target: parseTarget(target), value, timeoutMs },
        (d) => formatAction("filled", `${q(target)} with ${q(value)}`, d),
      );
    }

    case "press": {
      const key = args[0];
      if (key === undefined) throw new CliError(2, "usage: bx press <key>");
      return send<ActionResult>(g, { cmd: "press", key }, (d) => formatAction("pressed", key, d));
    }

    case "select": {
      const timeoutMs = takeTimeout(args);
      const target = args[0];
      const value = args[1];
      if (target === undefined || value === undefined) {
        throw new CliError(2, "usage: bx select <target> <value>");
      }
      return send<ActionResult>(
        g,
        { cmd: "select", target: parseTarget(target), value, timeoutMs },
        (d) => formatAction("selected", `${q(value)} in ${q(target)}`, d),
      );
    }

    case "wait": {
      const timeoutMs = takeTimeout(args);
      const arg = args[0];
      if (arg === undefined) throw new CliError(2, "usage: bx wait <ms | selector | text>");
      const isMs = /^\d+$/.test(arg);
      const waitCmd: Cmd = isMs
        ? { cmd: "wait", ms: Number(arg) }
        : isSelectorLike(arg)
          ? { cmd: "wait", selector: arg, timeoutMs }
          : { cmd: "wait", text: arg, timeoutMs };
      return send<ActionResult>(g, waitCmd, (d) =>
        formatAction("waited", isMs ? `${arg}ms` : `for ${q(arg)}`, d),
      );
    }

    case "expect": {
      const timeoutMs = takeTimeout(args);
      const rawKind = args[0];
      const value = args[1];
      if (rawKind === undefined || value === undefined) {
        throw new CliError(2, "usage: bx expect <text|url|visible|not-visible> <value>");
      }
      const kind = expectKind(rawKind);
      const res = await cmd<ExpectResult>(
        g.profile,
        { cmd: "expect", kind, value, timeoutMs },
        { headless: g.headless },
      );
      const code = emit(g, res, (d) =>
        d.pass
          ? `✓ expect ${rawKind} ${q(value)}`
          : `✗ expect ${rawKind} ${q(value)} — ${d.detail} — --timeout <ms> to adjust`,
      );
      if (code !== 0) return code;
      return res.ok && res.data.pass ? 0 : 1;
    }

    case "mouse": {
      const { target, where } = takeIn(args);
      const button = mouseButton(takeOption(args, "--button"));
      const usage = "usage: bx mouse <click|dblclick|move|down|up> <x> <y> [--in <target>]";
      const action = mouseAction(args[0]);
      const x = coord(args[1], usage);
      const y = coord(args[2], usage);
      return send<ActionResult>(g, { cmd: "mouse", action, x, y, in: target, button }, (d) =>
        formatAction(`mouse ${action}`, `at ${x},${y}${where}`, d),
      );
    }

    case "drag": {
      const { target, where } = takeIn(args);
      const rawSteps = takeOption(args, "--steps");
      const usage =
        "usage: bx drag <x1> <y1> <x2> <y2> [--in <target>] [--steps <n>]" +
        " [--pointer] [--hold <ms>] [--step-delay <ms>]";
      const steps = rawSteps === undefined ? undefined : coord(rawSteps, "--steps takes a number");
      if (steps !== undefined && (!Number.isInteger(steps) || steps <= 0)) {
        throw new CliError(2, "--steps takes a positive whole number");
      }
      const mode = takeFlag(args, "--pointer") ? "pointer" : undefined;
      const holdMs = takeDelayMs(args, "--hold");
      const stepDelayMs = takeDelayMs(args, "--step-delay");
      const fromX = coord(args[0], usage);
      const fromY = coord(args[1], usage);
      const toX = coord(args[2], usage);
      const toY = coord(args[3], usage);
      return send<ActionResult>(
        g,
        { cmd: "drag", fromX, fromY, toX, toY, in: target, steps, mode, holdMs, stepDelayMs },
        (d) => formatAction("dragged", `${fromX},${fromY} → ${toX},${toY}${where}`, d),
      );
    }

    case "key": {
      const action = args[0];
      const key = args[1];
      if ((action !== "down" && action !== "up") || key === undefined) {
        throw new CliError(2, "usage: bx key <down|up> <key>");
      }
      return send<ActionResult>(g, { cmd: "key", action, key }, (d) =>
        formatAction(`key ${action}`, q(key), d),
      );
    }

    case "wheel": {
      const { target, where } = takeIn(args);
      const usage = "usage: bx wheel <deltaY> [x y] [--in <target>]";
      const deltaY = coord(args[0], usage);
      const hasPoint = args[1] !== undefined;
      const x = hasPoint ? coord(args[1], usage) : undefined;
      const y = hasPoint ? coord(args[2], usage) : undefined;
      return send<ActionResult>(g, { cmd: "wheel", deltaY, x, y, in: target }, (d) =>
        formatAction("wheel", hasPoint ? `${deltaY} at ${x},${y}${where}` : String(deltaY), d),
      );
    }

    case "drive": {
      const usage =
        'usage: bx drive --install "<js>" --until "<expr>" [--timeout <ms>] [--poll <ms>]';
      const timeoutMs = takePositiveMs(args, "--timeout");
      const pollMs = takePositiveMs(args, "--poll");
      const install = takeOption(args, "--install");
      const until = takeOption(args, "--until");
      if (install === undefined || until === undefined) throw new CliError(2, usage);
      const res = await cmd<DriveResult>(
        g.profile,
        { cmd: "drive", install, until, timeoutMs, pollMs },
        { headless: g.headless },
      );
      const code = emit(g, res, (d) =>
        d.satisfied
          ? `✓ satisfied after ${(d.elapsedMs / 1000).toFixed(1)}s (${d.polls} polls)`
          : `✗ not satisfied after ${(d.elapsedMs / 1000).toFixed(1)}s (${d.polls} polls)` +
            ` — last value: ${d.finalValue}`,
      );
      if (code !== 0) return code;
      return res.ok && res.data.satisfied ? 0 : 1;
    }

    case "snap": {
      const full = takeFlag(args, "--full");
      const raw = args[0];
      // Resolved here: the daemon's cwd is not the caller's.
      const target = raw === undefined ? undefined : path.resolve(process.cwd(), raw);
      return send<SnapResult>(g, { cmd: "snap", path: target, full }, (d) =>
        `saved ${d.path} (${d.width}x${d.height}, ${Math.max(1, Math.round(d.bytes / 1024))} KB)`,
      );
    }

    case "text": {
      const selector = args[0];
      return send<TextResult>(g, { cmd: "text", selector }, (d) =>
        d.truncated ? `${d.text}\n…(truncated)` : d.text,
      );
    }

    case "console": {
      const all = takeFlag(args, "--all");
      const filter = takeOption(args, "--filter");
      return send<ConsoleEntry[]>(g, { cmd: "console", all, filter }, (d) =>
        renderEntries(d, formatConsoleEntry),
      );
    }

    case "net": {
      const failed = takeFlag(args, "--failed");
      const filter = takeOption(args, "--filter");
      return send<NetEntry[]>(g, { cmd: "net", failed, filter }, (d) =>
        renderEntries(d, formatNetEntry),
      );
    }

    case "js": {
      const expression = args.join(" ").trim();
      if (expression.length === 0) throw new CliError(2, "usage: bx js <expression>");
      return send<JsResult>(g, { cmd: "js", expression }, (d) =>
        d.truncated ? `${d.value}\n…(truncated)` : d.value,
      );
    }

    case "back":
      return send<ActionResult>(g, { cmd: "back" }, (d) => formatAction("went back", "", d));

    case "reload":
      return send<ActionResult>(g, { cmd: "reload" }, (d) => formatAction("reloaded", "", d));

    case "tabs":
      return send<TabsResult>(g, { cmd: "tabs" }, (d) =>
        d.pages.length === 0 ? "(no tabs)" : d.pages.map(renderPage).join("\n"),
      );

    case "tab": {
      const sub = args[0];
      if (sub === "new") {
        const url = args[1];
        return send<TabsResult>(
          g,
          { cmd: "tabNew", url },
          renderTabChange("opened tab", url === undefined ? "" : url),
        );
      }
      if (sub === "close") {
        return send<TabsResult>(g, { cmd: "tabClose" }, renderTabChange("closed tab", ""));
      }
      if (sub !== undefined && /^\d+$/.test(sub)) {
        const index = Number(sub);
        return send<TabsResult>(
          g,
          { cmd: "tabSelect", index },
          renderTabChange("switched to tab", String(index)),
        );
      }
      throw new CliError(2, "usage: bx tab <n> | bx tab new [url] | bx tab close");
    }

    case "run": {
      const record = takeFlag(args, "--record");
      const file = args[0];
      if (file === undefined) throw new CliError(2, "usage: bx run <flow.ts> [--record]");
      const passed = await runFlow(file, { profile: g.profile, record });
      return passed ? 0 : 1;
    }

    case "record": {
      const sub = args[0];
      if (sub === "start") {
        const slug = args[1];
        if (slug === undefined) throw new CliError(2, "usage: bx record start <slug>");
        if (!/^[a-z0-9-]+$/.test(slug)) {
          throw new CliError(2, `slug must be lowercase letters, digits and dashes: "${slug}"`);
        }
        return send<RecordStartResult>(
          g,
          { cmd: "recordStart", slug },
          (d) => `● recording "${d.slug}" — bx record stop to package it`,
        );
      }
      if (sub === "stop") {
        const status = await cmd<StatusResult>(
          g.profile,
          { cmd: "status" },
          { headless: g.headless },
        );
        if (!status.ok) return emit(g, status, renderStatus);
        const slug = status.data.recording;
        if (slug === null) throw new CliError(1, "not recording");
        const outDir = path.resolve(process.cwd(), "recordings", slug);
        return send<RecordStopResult>(
          g,
          { cmd: "recordStop", outDir },
          (d) => `✓ recorded ${d.actionCount} actions\n  package  ${d.dir}\n  report   ${d.reportPath}`,
        );
      }
      throw new CliError(2, "usage: bx record start <slug> | bx record stop");
    }

    case "agent": {
      const model = agentModel(takeOption(args, "--model"));
      const save = takeOption(args, "--save");
      const maxTurns = takeMaxTurns(args);
      const budgetUsd = takeBudgetUsd(args);
      const maxWallMs = takeMaxWallMs(args);
      const verbose = takeFlag(args, "--verbose");
      const escalateOpus = takeFlag(args, "--opus");
      const startUrl = takeOption(args, "--url");
      const enterJs = takeOption(args, "--enter");
      const winExpr = takeOption(args, "--win");
      if (enterJs !== undefined && startUrl === undefined) {
        throw new CliError(2, "--enter needs --url (the setup JS needs a loaded page to run in)");
      }
      const instruction = args.join(" ").trim();
      if (instruction.length === 0) {
        throw new CliError(
          2,
          'usage: bx agent "<instruction>" [--model haiku|sonnet|opus] [--opus]' +
            " [--save <name>] [--max-turns <n>] [--verbose]" +
            " [--budget <usd>] [--max-wall <s>]" +
            " [--url <u>] [--enter <js>] [--win <expr>]",
        );
      }
      const options: AgentRunOptions = {
        instruction,
        profile: g.profile,
        model,
        save,
        maxTurns,
        verbose,
        escalateOpus,
        budgetUsd,
        maxWallMs,
        startUrl,
        enterJs,
        winExpr,
        // The heartbeat writes to stdout, which under --json must stay a single
        // parseable document.
        heartbeatTurns: g.json ? 0 : undefined,
      };
      const { runAgent } = await import("./agent/driver.ts");
      const report = await runAgent(options);
      if (g.json) {
        printJson(report);
      } else {
        out(renderReport(report));
      }
      return report.status === "pass" ? 0 : 1;
    }

    case "install-skill": {
      const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
      const source = path.join(pkgRoot, "skill", "SKILL.md");
      if (!fs.existsSync(source)) {
        throw new CliError(3, `skill file not found at ${source}`);
      }
      const destDir = path.join(os.homedir(), ".claude", "skills", "bx");
      fs.mkdirSync(destDir, { recursive: true });
      const dest = path.join(destDir, "SKILL.md");
      fs.copyFileSync(source, dest);
      if (g.json) {
        printJson({ installed: dest });
      } else {
        out(`✓ installed skill to ${dest}`);
        out(`Claude Code will now reach for bx on browser tasks — try: "use bx to verify your changes"`);
      }
      return 0;
    }

    case "status": {
      const run = readRunFile(g.profile);
      if (run === null || !(await isAlive(run))) {
        if (g.json) {
          printJson({ profile: g.profile, running: false });
        } else {
          out(`no daemon running for profile ${g.profile}`);
        }
        return 0;
      }
      return send<StatusResult>(g, { cmd: "status" }, renderStatus);
    }

    case "profiles": {
      const profiles = listProfiles();
      if (g.json) {
        printJson(profiles);
        return 0;
      }
      out(
        profiles.length === 0
          ? "(no profiles yet — one is created on first use)"
          : profiles
              .map((p) => `${p.running ? "●" : "○"} ${p.name} — ${p.running ? "running" : "stopped"}`)
              .join("\n"),
      );
      return 0;
    }

    case "stop": {
      const stopped = await stopDaemon(g.profile);
      if (g.json) {
        printJson({ profile: g.profile, stopped });
        return 0;
      }
      out(
        stopped
          ? `stopped daemon for profile ${g.profile}`
          : `no daemon running for profile ${g.profile}`,
      );
      return 0;
    }

    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return 0;

    default:
      process.stderr.write(`unknown command "${command}"\n\n`);
      process.stderr.write(USAGE);
      return 2;
  }
}

function reportFailure(err: unknown): number {
  if (err instanceof CliError) {
    process.stderr.write(`✗ ${err.message}\n`);
    return err.exitCode;
  }
  process.stderr.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
  return 3;
}

async function main(argv: string[]): Promise<number> {
  const raw = repairMsysArgs(argv);
  // Help is free: it answers before any daemon spawn or verb dispatch.
  if (raw.some((arg) => arg === "--help" || arg === "-h")) {
    process.stdout.write(USAGE);
    return 0;
  }

  const { globals, rest } = extractGlobals(raw);
  const [command, ...args] = rest;
  if (command === undefined) {
    process.stdout.write(USAGE);
    return 0;
  }

  startedAt = performance.now();
  let code: number;
  try {
    code = await dispatch(globals, command, args);
  } catch (err: unknown) {
    code = reportFailure(err);
  }
  reportTiming();
  return code;
}

const exitCode = await main(process.argv.slice(2)).catch(reportFailure);
process.exit(exitCode);
