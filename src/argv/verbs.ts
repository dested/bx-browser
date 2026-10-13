// The served verbs: parsed args → Cmd → daemon → rendered output and exit
// code. Runs in the Bun CLI (VerbIO over HTTP and process streams) and in the
// daemon's /argv route (VerbIO in process, output buffered), so both print the
// same bytes. node:* only, no Bun APIs.

import type { BxError, Cmd, CmdResult, JsResult } from "../protocol.ts";
import { CliError } from "./errors.ts";
import { renderEl } from "./format.ts";
import type { ArgvEnv, Globals } from "./parse.ts";

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
}

function out(io: VerbIO, text: string): void {
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

/** True for `js -` and `js @file`: the code comes from the caller's stdin or disk. */
function jsFromCaller(args: string[]): boolean {
  const first = args[0];
  return args.length === 1 && first !== undefined && (first === "-" || (first.startsWith("@") && first.length > 1));
}

/** Whether the daemon's /argv route can run this verb; the rest fall back to the Bun CLI. */
export function isServed(command: string, args: string[]): boolean {
  // Sample checkpoint: js only. The full refactor serves every daemon verb.
  return command === "js" && !jsFromCaller(args);
}

/** Runs one served verb. `args` is consumed (flags are spliced out). */
export async function runVerb(g: Globals, command: string, args: string[], io: VerbIO): Promise<number> {
  switch (command) {
    case "js": {
      const expression = args.join(" ").trim();
      if (expression.length === 0) throw new CliError(2, "usage: bx js <expression | - | @file.js>");
      return send<JsResult>(io, g, { cmd: "js", expression }, (d) =>
        d.truncated ? `${d.value}\n…(truncated)` : d.value,
      );
    }
    default:
      throw new CliError(2, `not served: ${command}`);
  }
}
