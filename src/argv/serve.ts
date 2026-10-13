// The daemon's POST /argv: a whole bx command line in, the bytes the Bun CLI
// would have printed out. bx.exe (dotnet/bx) posts here so a single command
// costs one native process start instead of a Bun one. Runs under Node inside
// the daemon: node:* only, no Bun APIs.

import type { CmdResult, Cmd } from "../protocol.ts";
import { toEnvelope, isRecord } from "./envelope.ts";
import {
  type ArgvEnv,
  type Globals,
  deadlineFor,
  encodeClientTag,
  extractGlobals,
  LOCAL_VERBS,
  modeNoteText,
  repairMsysArgs,
  wantsHelp,
} from "./parse.ts";
import { isServed, reportFailure, reportTiming, runVerb, type VerbIO } from "./verbs.ts";

export interface ArgvRequest {
  argv: string[];
  cwd: string;
  pid?: number;
  env: ArgvEnv;
}

export type ArgvResponse = { stdout: string; stderr: string; exit: number } | { fallback: true };

export interface ArgvDeps {
  profile: string;
  headless: boolean;
  /**
   * Runs one /cmd body exactly as POST /cmd does (schema check, journal,
   * deadline, log line) and returns its envelope.
   */
  runCmd(body: unknown, clientHeader: string, deadlineHeader: string): Promise<CmdResult>;
}

const FALLBACK: ArgvResponse = { fallback: true };

const ENV_KEYS = ["BX_TIMING", "MSYSTEM", "EXEPATH", "CLAUDE_CODE_SESSION_ID"] as const;

function toArgvRequest(v: unknown): ArgvRequest | null {
  if (!isRecord(v)) return null;
  const { argv, cwd, pid, env } = v;
  if (!Array.isArray(argv) || !argv.every((a): a is string => typeof a === "string")) return null;
  if (typeof cwd !== "string" || cwd === "") return null;
  if (pid !== undefined && (typeof pid !== "number" || !Number.isInteger(pid))) return null;
  const cleanEnv: ArgvEnv = {};
  if (env !== undefined) {
    if (!isRecord(env)) return null;
    for (const key of ENV_KEYS) {
      const value = env[key];
      if (typeof value === "string") cleanEnv[key] = value;
    }
  }
  return { argv, cwd, ...(pid === undefined ? {} : { pid }), env: cleanEnv };
}

export async function serveArgv(body: unknown, deps: ArgvDeps): Promise<ArgvResponse> {
  const req = toArgvRequest(body);
  if (req === null) return FALLBACK;
  const argv = repairMsysArgs(req.argv, req.env);
  // Usage errors in the globals, help and a bare `bx` all print from the CLI.
  if (wantsHelp(argv)) return FALLBACK;
  let parsed: { globals: Globals; rest: string[] };
  try {
    parsed = extractGlobals(argv);
  } catch {
    return FALLBACK;
  }
  const g = parsed.globals;
  const [command, ...args] = parsed.rest;
  if (command === undefined || LOCAL_VERBS.has(command)) return FALLBACK;
  if (g.profile !== deps.profile || !isServed(command, args)) return FALLBACK;

  const startedAt = performance.now();
  let stdout = "";
  let stderr = "";
  const io: VerbIO = {
    cwd: req.cwd,
    env: req.env,
    stdout: (chunk) => {
      stdout += chunk;
    },
    stderr: (chunk) => {
      stderr += chunk;
    },
    elapsedMs: () => Math.round(performance.now() - startedAt),
    send: async <T>(c: Cmd, globals: Globals): Promise<CmdResult<T>> => {
      const note = modeNoteText(
        { profile: deps.profile, headless: deps.headless },
        { headless: globals.headless ?? false, explicit: globals.headless !== undefined },
      );
      if (note !== null) stderr += note;
      const tag = encodeClientTag({
        session: req.env.CLAUDE_CODE_SESSION_ID || undefined,
        cwd: req.cwd,
        pid: req.pid,
        via: command,
      });
      const result = await deps.runCmd(c, tag, String(deadlineFor(c, globals.deadlineMs)));
      // Through JSON and the client's own envelope check, so the payload is
      // exactly what the CLI would have parsed off the wire.
      const envelope = toEnvelope(JSON.parse(JSON.stringify(result)));
      if (envelope === null) throw new Error("unexpected daemon response (HTTP 200)");
      if (!envelope.ok) return { ok: false, error: envelope.error };
      // The envelope is checked; the payload shape is the command's contract in
      // protocol.ts and is trusted here, as in client.ts's post().
      const data = envelope.data as T;
      return envelope.relaunched ? { ok: true, data, relaunched: true } : { ok: true, data };
    },
  };

  let exit: number;
  try {
    exit = await runVerb(g, command, args, io);
  } catch (err: unknown) {
    exit = reportFailure(io, err);
  }
  reportTiming(io);
  return { stdout, stderr, exit };
}
