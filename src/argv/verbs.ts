// The served verbs: parsed args → Cmd → daemon → rendered output and exit
// code. Runs in the Bun CLI (VerbIO over HTTP and process streams) and in the
// daemon's /argv route (VerbIO in process, output buffered), so both print the
// same bytes. node:* only, no Bun APIs.

import { readFile } from "node:fs/promises";
import * as path from "node:path";
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
  NetBodyResult,
  NetEntry,
  OpenResult,
  RecordStartResult,
  RecordStatusResult,
  RecordStopResult,
  SnapResult,
  StatusResult,
  TabsResult,
  Target,
  TextResult,
} from "../protocol.ts";
import { CliError } from "./errors.ts";
import {
  formatAction,
  formatConsoleEntry,
  formatNetEntry,
  renderEl,
  renderEls,
  renderEntries,
  renderPage,
  renderStatus,
  renderTabChange,
} from "./format.ts";
import { type ArgvEnv, type Globals, LOCAL_VERBS, takeFlag, takeOption } from "./parse.ts";
import { isSelectorLike, type MatchOpts, parseTarget } from "./target.ts";
import { USAGE } from "./usage.ts";

export interface VerbIO {
  /** One Cmd to this profile's daemon: HTTP from the CLI, in process inside /argv. */
  send<T>(c: Cmd, g: Globals): Promise<CmdResult<T>>;
  stdout(chunk: string): void;
  stderr(chunk: string): void;
  /** The caller's working directory; relative paths resolve against it. */
  cwd: string;
  env: ArgvEnv;
  /** Wall time since the command started, for --json "ms" and BX_TIMING. */
  elapsedMs(): number;
  /** The caller's stdin, for `js -`. Absent in the daemon, which never serves it. */
  readStdin?(): Promise<string>;
}

export function out(io: VerbIO, text: string): void {
  if (text.length > 0) io.stdout(`${text}\n`);
}

// JSON payloads that are objects carry the timing inline; the list-shaped ones
// (console, net, profiles) stay arrays and print unchanged.
export function printJson(io: VerbIO, value: unknown): void {
  const payload =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? { ...value, ms: io.elapsedMs() }
      : value;
  io.stdout(`${JSON.stringify(payload)}\n`);
}

export function reportTiming(io: VerbIO): void {
  const flag = io.env.BX_TIMING;
  if (flag === undefined || flag === "" || flag === "0") return;
  io.stderr(`(${io.elapsedMs()}ms)\n`);
}

export function exitCodeFor(code: BxError["code"]): number {
  if (code === "browser_launch_failed" || code === "browser_dead" || code === "internal") return 3;
  if (code === "bad_request") return 2;
  return 1;
}

function printError(io: VerbIO, error: BxError): void {
  io.stderr(`✗ ${error.code}: ${error.message}\n`);
  if (error.nearMatches && error.nearMatches.length > 0) {
    io.stderr("did you mean:\n");
    for (const el of error.nearMatches) io.stderr(`  ${renderEl(el)}\n`);
  }
}

export function reportFailure(io: VerbIO, err: unknown): number {
  if (err instanceof CliError) {
    io.stderr(`✗ ${err.message}\n`);
    return err.exitCode;
  }
  io.stderr(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
  return 3;
}

function emit<T>(io: VerbIO, g: Globals, res: CmdResult<T>, render: (data: T) => string): number {
  if (res.ok && res.relaunched === true) {
    io.stderr("note: the browser had closed, so bx relaunched it (earlier tabs are gone)\n");
  }
  if (g.json) {
    printJson(io, res.ok ? res.data : res.error);
    return res.ok ? 0 : exitCodeFor(res.error.code);
  }
  if (!res.ok) {
    printError(io, res.error);
    return exitCodeFor(res.error.code);
  }
  out(io, render(res.data));
  return 0;
}

async function send<T>(io: VerbIO, g: Globals, c: Cmd, render: (data: T) => string): Promise<number> {
  return emit(io, g, await io.send<T>(c, g), render);
}

function q(s: string): string {
  return JSON.stringify(s);
}

// ---------------------------------------------------------------------------
// Option parsing shared by the verbs below
// ---------------------------------------------------------------------------

function takeTimeout(args: string[]): number | undefined {
  const value = takeOption(args, "--timeout");
  if (value === undefined) return undefined;
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new CliError(2, "--timeout takes a positive number of milliseconds");
  }
  return ms;
}

function takeMatch(args: string[]): MatchOpts {
  return { exact: takeFlag(args, "--exact"), first: takeFlag(args, "--first") };
}

type Then = "els" | "text" | "snap";

/** --settle, --then and --until: the options every action verb shares. */
function takeActionOpts(args: string[]): { settle?: number; then?: Then; until?: string } {
  const settle = takeDelayMs(args, "--settle");
  const rawThen = takeOption(args, "--then");
  const until = takeOption(args, "--until");
  if (rawThen !== undefined && rawThen !== "els" && rawThen !== "text" && rawThen !== "snap") {
    throw new CliError(2, `--then takes els | text | snap, not "${rawThen}"`);
  }
  return {
    ...(settle === undefined ? {} : { settle }),
    ...(rawThen === undefined ? {} : { then: rawThen }),
    ...(until === undefined ? {} : { until }),
  };
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

/**
 * `bx js -` reads the code from stdin and `bx js @file.js` from a file
 * (resolved against the caller's cwd), so multi-line code needs no shell
 * quoting. Anything else is the code itself.
 */
async function jsSource(io: VerbIO, g: Globals, args: string[]): Promise<string> {
  const first = args[0];
  if (args.length === 1 && first === "-") {
    if (g.batch) throw new CliError(2, "bx js - reads stdin, which a batch is already using: use js @file.js");
    if (io.readStdin === undefined) throw new CliError(2, "bx js - needs the caller's stdin");
    return (await io.readStdin()).trim();
  }
  if (args.length === 1 && first !== undefined && first.startsWith("@") && first.length > 1) {
    const file = path.resolve(io.cwd, first.slice(1));
    try {
      return (await readFile(file, "utf8")).trim();
    } catch {
      throw new CliError(2, `bx js: can't read ${file}`);
    }
  }
  return args.join(" ").trim();
}

/** yyyymmdd-hhmmss in local time: default recording slugs. */
function recordStamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const RECORD_SLUG = /^[a-z0-9-]+$/;

function recordSlug(raw: string | undefined, fallback: string): string {
  const slug = raw ?? fallback;
  if (!RECORD_SLUG.test(slug)) throw new CliError(2, `slug must be lowercase letters, digits and dashes: "${slug}"`);
  return slug;
}

function intOption(args: string[], name: string, min: number, max: number): number | undefined {
  const raw = takeOption(args, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new CliError(2, `${name} must be a whole number from ${min} to ${max}`);
  }
  return n;
}

/** The package lines shared by record stop, save and distill. */
function renderPackage(head: string, d: RecordStopResult): string {
  const lines = [
    `${head} — ${d.actionCount} action${d.actionCount === 1 ? "" : "s"}, ${(d.durationMs / 1000).toFixed(1)}s, ${d.frames} frame${d.frames === 1 ? "" : "s"}`,
    `  package  ${d.dir}`,
    `  video    ${d.videoPath}`,
  ];
  if (d.mp4Path !== undefined) lines.push(`  mp4      ${d.mp4Path}`);
  lines.push(
    d.distill === "done"
      ? `  report   ${d.reportPath}`
      : d.distill === "running"
        ? "  report   distilling in the background — bx record status"
        : `  report   distill failed — see ${path.join(d.dir, "distill.log")}`,
  );
  return lines.join("\n");
}

function renderRecordStatus(d: RecordStatusResult): string {
  const lines: string[] = [];
  if (!d.recording) {
    lines.push("not recording");
  } else {
    const parts = [`tab ${d.tab ?? "?"}${d.follow === true ? " (follow)" : ""}`];
    if (d.ring !== undefined) parts.push(`ring ${d.ring}s, ${((d.bufferedBytes ?? 0) / 1_048_576).toFixed(1)} MB held`);
    parts.push(`${((d.elapsedMs ?? 0) / 1000).toFixed(1)}s`, `${d.frames ?? 0} frames`, `${d.marks ?? 0} marks`);
    lines.push(`● recording "${d.slug ?? ""}" — ${parts.join(", ")}`);
  }
  for (const dir of d.distilling) lines.push(`  distilling ${dir}`);
  return lines.join("\n");
}

/**
 * Whether the daemon's /argv route can run this verb. The rest fall back to
 * the Bun CLI: LOCAL_VERBS, and `js -` (the code is on the caller's stdin).
 */
export function isServed(command: string, args: string[]): boolean {
  if (LOCAL_VERBS.has(command)) return false;
  return !(command === "js" && args.length === 1 && args[0] === "-");
}

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

/**
 * Runs one served verb (every verb outside LOCAL_VERBS; an unknown one prints
 * the usage). `args` is consumed: flags are spliced out as they are read.
 */
export async function runVerb(g: Globals, command: string, args: string[], io: VerbIO): Promise<number> {
  switch (command) {
    case "open": {
      const url = args[0];
      if (url === undefined) throw new CliError(2, "usage: bx open <url>");
      return send<OpenResult>(io, g, { cmd: "open", url }, (d) =>
        `✓ ${d.page.title || "(untitled)"} — ${d.page.url}\n\n${renderEls(d.els)}`,
      );
    }

    case "els": {
      const all = takeFlag(args, "--all");
      const diff = takeFlag(args, "--diff");
      const clickables = takeFlag(args, "--clickables");
      const filter = takeOption(args, "--filter");
      return send<ElsResult>(io, g, { cmd: "els", all, filter, diff, clickables }, renderEls);
    }

    case "click": {
      const timeoutMs = takeTimeout(args);
      const match = takeMatch(args);
      const act = takeActionOpts(args);
      const target = args[0];
      if (target === undefined) throw new CliError(2, "usage: bx click <target>");
      return send<ActionResult>(io, g,
        { cmd: "click", target: parseTarget(target, match), timeoutMs, ...act },
        (d) => formatAction("clicked", q(target), d),
      );
    }

    case "fill": {
      const timeoutMs = takeTimeout(args);
      const match = takeMatch(args);
      const act = takeActionOpts(args);
      const target = args[0];
      const value = args[1];
      if (target === undefined || value === undefined) {
        throw new CliError(2, "usage: bx fill <target> <value>");
      }
      return send<ActionResult>(io, g,
        { cmd: "fill", target: parseTarget(target, match), value, timeoutMs, ...act },
        (d) => formatAction("filled", `${q(target)} with ${q(value)}`, d),
      );
    }

    case "press": {
      const act = takeActionOpts(args);
      const key = args[0];
      if (key === undefined) throw new CliError(2, "usage: bx press <key>");
      return send<ActionResult>(io, g, { cmd: "press", key, ...act }, (d) => formatAction("pressed", key, d));
    }

    case "select": {
      const timeoutMs = takeTimeout(args);
      const match = takeMatch(args);
      const act = takeActionOpts(args);
      const target = args[0];
      const value = args[1];
      if (target === undefined || value === undefined) {
        throw new CliError(2, "usage: bx select <target> <value>");
      }
      return send<ActionResult>(io, g,
        { cmd: "select", target: parseTarget(target, match), value, timeoutMs, ...act },
        (d) => formatAction("selected", `${q(value)} in ${q(target)}`, d),
      );
    }

    case "wait": {
      const timeoutMs = takeTimeout(args);
      const match = takeMatch(args);
      const idle = takeFlag(args, "--idle");
      const gone = takeOption(args, "--gone");
      const url = takeOption(args, "--url");
      const js = takeOption(args, "--js");
      const named = (idle ? 1 : 0) + [gone, url, js].filter((c) => c !== undefined).length;
      if (named > 1 || (named === 1 && args[0] !== undefined)) {
        throw new CliError(2, "bx wait takes one condition: <ms | selector | text>, --idle, --gone, --url or --js");
      }
      if (idle) {
        return send<ActionResult>(io, g, { cmd: "wait", idle, timeoutMs }, (d) => formatAction("waited", "until idle", d));
      }
      if (gone !== undefined) {
        return send<ActionResult>(io, g, { cmd: "wait", gone: parseTarget(gone, match), timeoutMs }, (d) =>
          formatAction("waited", `until ${q(gone)} was gone`, d),
        );
      }
      if (url !== undefined) {
        return send<ActionResult>(io, g, { cmd: "wait", url, timeoutMs }, (d) =>
          formatAction("waited", `for url ${q(url)}`, d),
        );
      }
      if (js !== undefined) {
        return send<ActionResult>(io, g, { cmd: "wait", js, timeoutMs }, (d) =>
          formatAction("waited", `until js ${q(js)}`, d),
        );
      }
      const arg = args[0];
      if (arg === undefined) {
        throw new CliError(
          2,
          "usage: bx wait <ms | selector | text> | --idle | --gone <target> | --url <part> | --js <expr>",
        );
      }
      const isMs = /^\d+$/.test(arg);
      const waitCmd: Cmd = isMs
        ? { cmd: "wait", ms: Number(arg) }
        : isSelectorLike(arg)
          ? { cmd: "wait", selector: arg, timeoutMs }
          : { cmd: "wait", text: arg, timeoutMs };
      return send<ActionResult>(io, g, waitCmd, (d) =>
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
      const res = await io.send<ExpectResult>({ cmd: "expect", kind, value, timeoutMs }, g);
      const code = emit(io, g, res, (d) =>
        d.pass
          ? `✓ expect ${rawKind} ${q(value)}`
          : `✗ expect ${rawKind} ${q(value)} — ${d.detail} — --timeout <ms> to adjust`,
      );
      if (code !== 0) return code;
      return res.ok && res.data.pass ? 0 : 1;
    }

    case "mouse": {
      const { target, where } = takeIn(args);
      const act = takeActionOpts(args);
      const button = mouseButton(takeOption(args, "--button"));
      const usage = "usage: bx mouse <click|dblclick|move|down|up> <x> <y> [--in <target>]";
      const action = mouseAction(args[0]);
      const x = coord(args[1], usage);
      const y = coord(args[2], usage);
      return send<ActionResult>(io, g, { cmd: "mouse", action, x, y, in: target, button, ...act }, (d) =>
        formatAction(`mouse ${action}`, `at ${x},${y}${where}`, d),
      );
    }

    case "drag": {
      const { target, where } = takeIn(args);
      const act = takeActionOpts(args);
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
      return send<ActionResult>(io, g,
        { cmd: "drag", fromX, fromY, toX, toY, in: target, steps, mode, holdMs, stepDelayMs, ...act },
        (d) => formatAction("dragged", `${fromX},${fromY} → ${toX},${toY}${where}`, d),
      );
    }

    case "key": {
      const act = takeActionOpts(args);
      const action = args[0];
      const key = args[1];
      if ((action !== "down" && action !== "up") || key === undefined) {
        throw new CliError(2, "usage: bx key <down|up> <key>");
      }
      return send<ActionResult>(io, g, { cmd: "key", action, key, ...act }, (d) =>
        formatAction(`key ${action}`, q(key), d),
      );
    }

    case "wheel": {
      const { target, where } = takeIn(args);
      const act = takeActionOpts(args);
      const usage = "usage: bx wheel <deltaY> [x y] [--in <target>]";
      const deltaY = coord(args[0], usage);
      const hasPoint = args[1] !== undefined;
      const x = hasPoint ? coord(args[1], usage) : undefined;
      const y = hasPoint ? coord(args[2], usage) : undefined;
      return send<ActionResult>(io, g, { cmd: "wheel", deltaY, x, y, in: target, ...act }, (d) =>
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
      const res = await io.send<DriveResult>({ cmd: "drive", install, until, timeoutMs, pollMs }, g);
      const code = emit(io, g, res, (d) =>
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
      const stable = takeFlag(args, "--stable");
      const jpegFlag = takeFlag(args, "--jpeg");
      const el = takeOption(args, "--el");
      const rawQuality = takeOption(args, "--quality");
      const quality = rawQuality === undefined ? undefined : Number(rawQuality);
      if (quality !== undefined && (!Number.isInteger(quality) || quality < 1 || quality > 100)) {
        throw new CliError(2, "--quality takes a whole number from 1 to 100");
      }
      const raw = args[0];
      // A .jpg path, --quality or --jpeg all mean JPEG.
      const jpeg = jpegFlag || quality !== undefined || (raw !== undefined && /\.jpe?g$/i.test(raw));
      // Resolved here: the daemon's cwd is not the caller's.
      const file = raw === undefined ? undefined : path.resolve(io.cwd, raw);
      const target = el === undefined ? undefined : parseTarget(el);
      return send<SnapResult>(io, g, { cmd: "snap", path: file, full, stable, target, jpeg, quality }, (d) =>
        `saved ${d.path} (${d.width}x${d.height}, ${Math.max(1, Math.round(d.bytes / 1024))} KB)`,
      );
    }

    case "text": {
      const timeoutMs = takeTimeout(args);
      const md = takeFlag(args, "--md");
      const match = takeMatch(args);
      const raw = args[0];
      const target = raw === undefined ? undefined : parseTarget(raw, match);
      return send<TextResult>(io, g, { cmd: "text", target, md, timeoutMs }, (d) =>
        d.truncated ? `${d.text}\n…(truncated)` : d.text,
      );
    }

    case "console": {
      const all = takeFlag(args, "--all");
      const allTabs = takeFlag(args, "--all-tabs");
      const filter = takeOption(args, "--filter");
      return send<ConsoleEntry[]>(io, g, { cmd: "console", all, filter, allTabs }, (d) =>
        renderEntries(d, formatConsoleEntry),
      );
    }

    case "net": {
      if (args[0] === "body") {
        const id = Number(args[1]);
        if (args[1] === undefined || !Number.isInteger(id) || id < 0) {
          throw new CliError(2, "usage: bx net body <id>");
        }
        return send<NetBodyResult>(io, g, { cmd: "netBody", id }, (d) =>
          `${d.status} ${d.contentType} ${d.url}\n\n${d.body}${d.truncated ? "\n…(truncated)" : ""}`,
        );
      }
      const failed = takeFlag(args, "--failed");
      const all = takeFlag(args, "--all");
      const allTabs = takeFlag(args, "--all-tabs");
      const filter = takeOption(args, "--filter");
      return send<NetEntry[]>(io, g, { cmd: "net", failed, filter, all, allTabs }, (d) =>
        renderEntries(d, formatNetEntry),
      );
    }

    case "js": {
      const expression = await jsSource(io, g, args);
      if (expression.length === 0) throw new CliError(2, "usage: bx js <expression | - | @file.js>");
      return send<JsResult>(io, g, { cmd: "js", expression }, (d) =>
        d.truncated ? `${d.value}\n…(truncated)` : d.value,
      );
    }

    case "back": {
      const act = takeActionOpts(args);
      return send<ActionResult>(io, g, { cmd: "back", ...act }, (d) => formatAction("went back", "", d));
    }

    case "reload": {
      const act = takeActionOpts(args);
      return send<ActionResult>(io, g, { cmd: "reload", ...act }, (d) => formatAction("reloaded", "", d));
    }

    case "tabs":
      return send<TabsResult>(io, g, { cmd: "tabs" }, (d) =>
        d.pages.length === 0 ? "(no tabs)" : d.pages.map(renderPage).join("\n"),
      );

    case "tab": {
      const sub = args[0];
      if (sub === "new") {
        const url = args[1];
        return send<TabsResult>(io, g,
          { cmd: "tabNew", url },
          renderTabChange("opened tab", url === undefined ? "" : url),
        );
      }
      if (sub === "close") {
        const all = takeFlag(args, "--all");
        const others = takeFlag(args, "--others");
        if (all && others) {
          throw new CliError(2, "bx tab close: pass at most one of --all, --others");
        }
        const scope = all ? "all" : others ? "others" : undefined;
        const verb = scope === "all" ? "closed all tabs" : scope === "others" ? "closed other tabs" : "closed tab";
        return send<TabsResult>(io, g, { cmd: "tabClose", scope }, renderTabChange(verb, ""));
      }
      if (sub !== undefined && /^\d+$/.test(sub)) {
        const index = Number(sub);
        return send<TabsResult>(io, g,
          { cmd: "tabSelect", index },
          renderTabChange("switched to tab", String(index)),
        );
      }
      throw new CliError(
        2,
        "usage: bx tab <n> | bx tab new [url] | bx tab close [--others | --all]",
      );
    }

    case "record": {
      const sub = args[0];
      if (sub === "start") {
        const follow = takeFlag(args, "--follow");
        const tab = intOption(args, "--tab", 1, Number.MAX_SAFE_INTEGER);
        const ring = intOption(args, "--ring", 5, 600);
        const fpsRaw = takeOption(args, "--fps");
        if (fpsRaw !== undefined && fpsRaw !== "30" && fpsRaw !== "60") throw new CliError(2, "--fps must be 30 or 60");
        const fps = fpsRaw === "60" ? 60 : fpsRaw === "30" ? 30 : undefined;
        if (follow && tab !== undefined) throw new CliError(2, "bx record start: pass --tab or --follow, not both");
        const slug = recordSlug(args[1], `rec-${recordStamp()}`);
        return send<RecordStartResult>(
          io,
          g,
          { cmd: "recordStart", slug, tab, follow: follow || undefined, ring, fps },
          (d) =>
            `● recording "${d.slug}" — tab ${d.tab}${follow ? " (follow)" : ""}` +
            `${d.ring === undefined ? "" : `, last ${d.ring}s kept in memory`}, first frame in ${d.firstFrameMs} ms\n` +
            (d.ring === undefined
              ? '  bx record mark "<text>" · bx record stop'
              : '  bx record save --last <secs> · bx record mark "<text>" · bx record stop'),
        );
      }
      if (sub === "mark") {
        const text = args.slice(1).join(" ");
        if (text === "") throw new CliError(2, 'usage: bx record mark "<text>"');
        return send<RecordStatusResult>(
          io,
          g,
          { cmd: "recordMark", text },
          (d) => `● mark ${d.marks ?? 0} at ${((d.elapsedMs ?? 0) / 1000).toFixed(1)}s: ${text}`,
        );
      }
      if (sub === "stop") {
        const distill = takeFlag(args, "--distill");
        const mp4 = takeFlag(args, "--mp4");
        const status = await io.send<StatusResult>({ cmd: "status" }, g);
        if (!status.ok) return emit(io, g, status, renderStatus);
        const slug = status.data.recording;
        if (slug === null) throw new CliError(1, "not recording");
        const outDir = path.resolve(io.cwd, "recordings", slug);
        return send<RecordStopResult>(
          io,
          g,
          { cmd: "recordStop", outDir, distill: distill || undefined, mp4: mp4 || undefined },
          (d) => renderPackage("✓ recorded", d),
        );
      }
      if (sub === "save") {
        const mp4 = takeFlag(args, "--mp4");
        const lastSecs = intOption(args, "--last", 1, 600);
        if (lastSecs === undefined) throw new CliError(2, "usage: bx record save --last <secs> [slug] [--mp4]");
        const status = await io.send<StatusResult>({ cmd: "status" }, g);
        if (!status.ok) return emit(io, g, status, renderStatus);
        const recording = status.data.recording;
        if (recording === null) throw new CliError(1, "not recording");
        const slug = recordSlug(args[1], `${recording}-${recordStamp()}`);
        const outDir = path.resolve(io.cwd, "recordings", slug);
        return send<RecordStopResult>(
          io,
          g,
          { cmd: "recordSave", lastSecs, outDir, mp4: mp4 || undefined },
          (d) => renderPackage(`✓ saved the last ${lastSecs}s`, d),
        );
      }
      if (sub === "status") {
        return send<RecordStatusResult>(io, g, { cmd: "recordStatus" }, renderRecordStatus);
      }
      if (sub === "distill") {
        const dir = args[1];
        if (dir === undefined) throw new CliError(2, "usage: bx record distill <dir>");
        const res = await io.send<RecordStopResult>({ cmd: "recordDistill", dir: path.resolve(io.cwd, dir) }, g);
        const code = emit(io, g, res, (d) =>
          renderPackage(d.distill === "done" ? "✓ distilled" : "✗ distill failed", d),
        );
        if (code !== 0) return code;
        // The package is still there, but the one thing asked for didn't happen.
        return res.ok && res.data.distill === "failed" ? 1 : 0;
      }
      throw new CliError(
        2,
        "usage: bx record start [slug] [--tab <id> | --follow] [--ring <secs>] [--fps 30|60]\n" +
          '       bx record mark "<text>" | bx record stop [--distill] [--mp4]\n' +
          "       bx record save --last <secs> [slug] [--mp4] | bx record status | bx record distill <dir>",
      );
    }

    // The CLI answers "no daemon running" itself before it gets here; inside
    // the daemon one plainly is.
    case "status":
      return send<StatusResult>(io, g, { cmd: "status" }, renderStatus);

    default:
      io.stderr(`unknown command "${command}"\n\n`);
      io.stderr(USAGE);
      return 2;
  }
}
