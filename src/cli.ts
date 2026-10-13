#!/usr/bin/env bun
// bx — browser automation for Claude Code. Hand-rolled argv parsing: the whole
// point is a tiny, predictable surface with no dependency weight.
//
// Parsing and rendering of the verbs a daemon serves live in src/argv/ (shared
// with the daemon's POST /argv, which bx.exe uses). This file keeps the process
// concerns: stdin, the batch loop, timing, and the verbs only the CLI runs.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "./argv/errors.ts";
import { type ArgvEnv, extractGlobals, type Globals, repairMsysArgs, takeFlag, takeOption, wantsHelp } from "./argv/parse.ts";
import { USAGE } from "./argv/usage.ts";
import { out, printJson, reportFailure, reportTiming, runVerb, type VerbIO } from "./argv/verbs.ts";
import { cmd, isAlive, listProfiles, readRunFile, setClientVia, stopAllDaemons, stopDaemon } from "./client.ts";
import { splitScript, splitWords } from "./script.ts";
import type { AgentModel, AgentReport, AgentRunOptions } from "./protocol.ts";

// ---------------------------------------------------------------------------
// argv (CLI-only verbs)
// ---------------------------------------------------------------------------

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

// Wall clock for one command: started once parsing is done, read again as each
// result is printed, so --json and BX_TIMING report the same number.
let startedAt = 0;

function cliEnv(): ArgvEnv {
  const env = process.env;
  return {
    BX_TIMING: env.BX_TIMING,
    MSYSTEM: env.MSYSTEM,
    EXEPATH: env.EXEPATH,
    CLAUDE_CODE_SESSION_ID: env.CLAUDE_CODE_SESSION_ID,
  };
}

/** The CLI side of VerbIO: HTTP to the daemon, this process's streams. */
const io: VerbIO = {
  send: (c, g) => cmd(g.profile, c, { headless: g.headless, deadlineMs: g.deadlineMs }),
  stdout: (chunk) => {
    process.stdout.write(chunk);
  },
  stderr: (chunk) => {
    process.stderr.write(chunk);
  },
  cwd: process.cwd(),
  env: cliEnv(),
  elapsedMs: () => Math.round(performance.now() - startedAt),
  readStdin: () => Bun.stdin.text(),
};

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
      `(${u.cacheReadTokens} cached)` +
      // est (pricing.ts on metered tokens) is the number to quote; sdk is the
      // SDK's own price table, which can lag new models by a wide margin.
      `${report.estUsd === undefined ? "" : ` est=$${report.estUsd.toFixed(4)}`}` +
      ` sdk=$${u.costUsd === null ? "n/a" : u.costUsd.toFixed(4)}`,
  );
  if (report.transcriptPath !== undefined) lines.push(`  transcript ${report.transcriptPath}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

/** The verbs only the CLI runs; everything else goes to the shared runVerb. */
async function dispatch(g: Globals, command: string, args: string[]): Promise<number> {
  switch (command) {
    case "run": {
      const record = takeFlag(args, "--record");
      const file = args[0];
      if (file === undefined) throw new CliError(2, "usage: bx run <flow.ts> [--record]");
      // Loaded on demand: the runner pulls in zod and the flow synthesizer,
      // which no other verb needs on its startup path.
      const { runFlow } = await import("./flows/runner.ts");
      const passed = await runFlow(file, { profile: g.profile, record, headless: g.headless });
      return passed ? 0 : 1;
    }

    case "agent": {
      const model = agentModel(takeOption(args, "--model"));
      const save = takeOption(args, "--save");
      const maxTurns = takeMaxTurns(args);
      const budgetUsd = takeBudgetUsd(args);
      const maxWallMs = takeMaxWallMs(args);
      const verbose = takeFlag(args, "--verbose");
      const escalateOpus = takeFlag(args, "--opus");
      const vision = takeFlag(args, "--vision");
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
            " [--url <u>] [--enter <js>] [--win <expr>] [--vision]",
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
        vision,
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
        printJson(io, report);
      } else {
        out(io, renderReport(report));
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
        printJson(io, { installed: dest });
      } else {
        out(io, `✓ installed skill to ${dest}`);
        out(io, `Claude Code will now reach for bx on browser tasks — try: "use bx to verify your changes"`);
      }
      return 0;
    }

    case "status": {
      const run = readRunFile(g.profile);
      if (run === null || !(await isAlive(run))) {
        if (g.json) {
          printJson(io, { profile: g.profile, running: false });
        } else {
          out(io, `no daemon running for profile ${g.profile}`);
        }
        return 0;
      }
      return runVerb(g, command, args, io);
    }

    case "doctor": {
      const fix = takeFlag(args, "--fix");
      // Loaded on demand: process and filesystem sweeps no other verb needs.
      const { doctor, formatDoctor } = await import("./maintenance.ts");
      const report = await doctor({ fix });
      if (g.json) printJson(io, report);
      else out(io, formatDoctor(report));
      return fix && report.findings.some((f) => f.fixed === false) ? 1 : 0;
    }

    case "gc": {
      const caches = takeFlag(args, "--caches");
      const yes = takeFlag(args, "--yes");
      const rawOlder = takeOption(args, "--older-than");
      const rawKeep = takeOption(args, "--keep");
      let olderThanDays: number | undefined;
      if (rawOlder !== undefined) {
        const m = /^(\d+)d?$/.exec(rawOlder);
        if (m?.[1] === undefined) throw new CliError(2, "--older-than takes days, e.g. 14d");
        olderThanDays = Number(m[1]);
      }
      const keep = rawKeep === undefined ? undefined : rawKeep.split(",").map((k) => k.trim()).filter((k) => k !== "");
      const { gc, formatGc } = await import("./maintenance.ts");
      process.stderr.write("scanning profiles (sizes every one; a few seconds)…\n");
      const report = await gc({ olderThanDays, caches, yes, keep });
      if (g.json) printJson(io, report);
      else out(io, formatGc(report, { limit: 40 }));
      return 0;
    }

    case "profiles": {
      const profiles = listProfiles();
      if (g.json) {
        printJson(io, profiles);
        return 0;
      }
      out(
        io,
        profiles.length === 0
          ? "(no profiles yet — one is created on first use)"
          : profiles
              .map((p) => `${p.running ? "●" : "○"} ${p.name} — ${p.running ? "running" : "stopped"}`)
              .join("\n"),
      );
      return 0;
    }

    case "stop": {
      if (takeFlag(args, "--all")) {
        const result = await stopAllDaemons();
        if (g.json) {
          printJson(io, result);
          return 0;
        }
        out(
        io,
          result.stopped.length === 0
            ? `no daemons running (cleared ${result.cleared.length} stale run files)`
            : `stopped ${result.stopped.length}: ${result.stopped.join(", ")}` +
                (result.cleared.length > 0 ? ` (cleared ${result.cleared.length} stale)` : ""),
        );
        return 0;
      }
      const stopped = await stopDaemon(g.profile);
      if (g.json) {
        printJson(io, { profile: g.profile, stopped });
        return 0;
      }
      out(
        io,
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
      return runVerb(g, command, args, io);
  }
}

async function main(argv: string[]): Promise<number> {
  const raw = repairMsysArgs(argv, io.env);
  // Help is free: it answers before any daemon spawn or verb dispatch.
  if (wantsHelp(raw)) {
    process.stdout.write(USAGE);
    return 0;
  }

  const { globals, rest } = extractGlobals(raw);
  const [command, ...args] = rest;
  if (command === undefined) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (command === "-" || command === "do") {
    const keepGoing = takeFlag(args, "--keep-going");
    const script = command === "-" ? await Bun.stdin.text() : args.join(" ");
    return runBatch({ ...globals, batch: true }, splitScript(script, command === "do"), keepGoing);
  }

  return runOne(globals, command, args);
}

async function runOne(g: Globals, command: string, args: string[]): Promise<number> {
  startedAt = performance.now();
  setClientVia(command);
  let code: number;
  try {
    code = await dispatch(g, command, args);
  } catch (err: unknown) {
    code = reportFailure(io, err);
  }
  reportTiming(io);
  return code;
}

// ---------------------------------------------------------------------------
// batch: `bx -` (one command per stdin line) and `bx do "a; b; c"`
// ---------------------------------------------------------------------------

/**
 * Runs each line as its own bx command in this one process, so the second
 * and later commands cost a localhost round trip instead of a process start.
 * Human output prefixes each command with `▸ <line>`; --json prints one JSON
 * line per command. Stops at the first failure unless --keep-going.
 */
async function runBatch(g: Globals, lines: string[], keepGoing: boolean): Promise<number> {
  let worst = 0;
  for (const line of lines) {
    let words: string[];
    try {
      words = splitWords(line);
    } catch (err: unknown) {
      worst = Math.max(worst, reportFailure(io, err));
      if (!keepGoing) return worst;
      continue;
    }
    const [command, ...args] = words;
    if (command === undefined) continue;
    if (command === "-" || command === "do") {
      worst = Math.max(worst, reportFailure(io, new CliError(2, "a batch can't start another batch")));
      if (!keepGoing) return worst;
      continue;
    }
    if (!g.json) out(io, `▸ ${line}`);
    const code = await runOne(g, command, args);
    worst = Math.max(worst, code);
    if (code !== 0 && !keepGoing) return code;
  }
  return worst;
}

const exitCode = await main(process.argv.slice(2)).catch((err: unknown) => reportFailure(io, err));
process.exit(exitCode);
