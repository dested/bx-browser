// argv → globals + verb. Shared by the Bun CLI and the daemon's /argv route:
// node:* only, no Bun APIs, nothing Node's type stripping can't erase.

import { DEFAULT_DEADLINE_MS } from "../constants.ts";
import type { ClientTag, Cmd } from "../protocol.ts";
import { CliError } from "./errors.ts";

/** The caller's environment variables argv handling reads. */
export interface ArgvEnv {
  BX_TIMING?: string;
  MSYSTEM?: string;
  EXEPATH?: string;
  CLAUDE_CODE_SESSION_ID?: string;
}

export interface Globals {
  profile: string;
  // undefined = the user did not ask; adopt whatever daemon is already running.
  headless: boolean | undefined;
  json: boolean;
  // Per-command daemon deadline (--deadline <ms>); undefined = client default.
  deadlineMs: number | undefined;
  // True while running a `bx -` / `bx do` batch: stdin is the script.
  batch: boolean;
}

// MSYS path conversion: Git Bash rewrites a bare `/foo` argument to
// `<EXEPATH>/foo` before bx ever sees it, corrupting urls, xpath targets and
// filters. Undo it by stripping that exact prefix back off — nothing else.
export function repairMsysArgs(argv: string[], env: ArgvEnv): string[] {
  const msystem = env.MSYSTEM;
  const exePath = env.EXEPATH;
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

export function wantsHelp(argv: string[]): boolean {
  return argv.some((arg) => arg === "--help" || arg === "-h");
}

export function extractGlobals(argv: string[]): { globals: Globals; rest: string[] } {
  const rest: string[] = [];
  let profile = "default";
  let headless: boolean | undefined;
  let json = false;
  let deadlineMs: number | undefined;

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
    if (arg === "--deadline") {
      const ms = Number(argv[i + 1]);
      if (!Number.isInteger(ms) || ms < 1000) {
        throw new CliError(2, "--deadline takes a whole number of milliseconds, 1000 or more");
      }
      deadlineMs = ms;
      i++;
      continue;
    }
    rest.push(arg);
  }
  return { globals: { profile, headless, json, deadlineMs, batch: false }, rest };
}

/**
 * Verbs only the Bun CLI runs: they read stdin, spawn processes, sweep the
 * disk or manage daemons. dotnet/bx/Program.cs keeps the same list.
 */
export const LOCAL_VERBS: ReadonlySet<string> = new Set([
  "run",
  "agent",
  "bench",
  "-",
  "do",
  "install-skill",
  "profiles",
  "stop",
  "doctor",
  "gc",
  "help",
  "-h",
  "--help",
]);

/**
 * The daemon-side deadline for a command: an explicit one wins; otherwise a
 * command with its own timeoutMs gets that plus 5 s of headroom, so a long
 * `--timeout` is never cut short by the default.
 */
export function deadlineFor(c: Cmd, explicit?: number): number {
  if (explicit !== undefined) return explicit;
  const own = "timeoutMs" in c && typeof c.timeoutMs === "number" ? c.timeoutMs + 5000 : 0;
  return Math.max(DEFAULT_DEADLINE_MS, own);
}

/**
 * The stderr note for a caller that asked for a mode the running daemon isn't
 * in, or null. Without `explicit` an ordinary command adopts whatever daemon
 * is up, silently.
 */
export function modeNoteText(
  run: { profile: string; headless: boolean },
  opts: { headless: boolean; explicit?: boolean },
): string | null {
  if (opts.explicit !== true || run.headless === opts.headless) return null;
  return `note: reusing the running ${run.headless ? "headless" : "headed"} daemon for "${run.profile}" — \`bx --profile ${run.profile} stop\` first to change mode\n`;
}

/** The CLIENT_HEADER value: who is driving the daemon, for /debug. */
export function encodeClientTag(tag: ClientTag): string {
  return encodeURIComponent(JSON.stringify(tag));
}
