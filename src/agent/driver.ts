// The natural-language driver: a cheap model operating the browser through the
// bx tools, so the expensive model that called `bx do` never has to.
//
// Cost control is the whole point. Haiku runs first with a tight tool surface
// and no filesystem/bash access; only if it fails to report a pass do we spend
// Sonnet on the same instruction, once.

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

import { cmd } from "../client.ts";
import { synthesizeFlow } from "../flows/synthesize.ts";
import { BX_SERVER_NAME, BX_TOOL_NAMES, createBxTools, type ToolSink } from "./tools.ts";
import { BX_DIR_NAME } from "../protocol.ts";
import type {
  ActionLogResult,
  AgentModel,
  AgentReport,
  AgentRunOptions,
  AgentUsage,
} from "../protocol.ts";

const MODEL_IDS: Record<AgentModel, string> = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-5",
};

const MAX_TURNS = 30;

const SYSTEM = `You are bx-driver, operating a real browser through bx tools. You cannot see the screen; you see distilled text. Work fast and precisely.
Method: (1) bx_open the target URL, or bx_els to see the current page. (2) Element lists show numbered refs like [3] button "Save" — act on them by passing the number as target, or pass visible text / a data-testid. (3) After any action that changes the page, the result tells you; call bx_els again only when you need fresh refs. (4) Verify every task outcome with bx_expect before reporting. (5) If a target is not found, read the 'did you mean' candidates and retry once with the best one. (6) Check bx_console if something seems broken.
Canvas/games: when the page is a canvas with no useful elements, act by coordinates — bx_mouse/bx_drag/bx_key with in set to the canvas testid so x/y are relative to its top-left; hold movement keys with bx_key down then up. You cannot see the canvas: read state the app exposes via bx_js (e.g. window.__game) and verify outcomes with bx_js too — bx_expect only sees DOM text.
Rules: never invent selectors; prefer testids and visible text. Keep to the task — do not explore. When the task is done (or truly impossible), call bx_report exactly once with status, a 2–3 sentence summary, and evidence (assertions passed, final URL). Then stop.`;

type Report = { status: "pass" | "fail"; summary: string; evidence: string[] };

interface Attempt {
  tier: AgentModel;
  report: Report | null;
  turns: number;
  usage: AgentUsage;
}

const ZERO_USAGE: AgentUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  costUsd: null,
};

function addUsage(a: AgentUsage, b: AgentUsage): AgentUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    costUsd: a.costUsd === null && b.costUsd === null ? null : (a.costUsd ?? 0) + (b.costUsd ?? 0),
  };
}

/** Runs one model tier end to end. Never throws: a crashed attempt is a failed attempt. */
async function runAttempt(
  opts: AgentRunOptions,
  tier: AgentModel,
  priorSummary: string | null,
): Promise<Attempt> {
  // Held in an object rather than a `let`: control-flow analysis ignores
  // assignments made inside the sink closure and would pin the type to null.
  const box: { report: Report | null } = { report: null };
  const sink: ToolSink = {
    setReport(r) {
      box.report = r;
    },
  };

  // Each attempt drives its own tab, so an escalation starts in a fresh page
  // and two concurrent runs never share one.
  const tools = createBxTools(opts.profile, sink);

  const prompt =
    priorSummary === null
      ? opts.instruction
      : `A previous attempt by a smaller model did not complete this task (its last report: ${priorSummary}). The browser is in whatever state it left. Start by calling bx_els to orient, then complete the task.\n\n${opts.instruction}`;

  const options: Options = {
    model: MODEL_IDS[tier],
    mcpServers: { [BX_SERVER_NAME]: tools.server },
    // `tools: []` drops every built-in (Bash, Read, Edit, WebFetch…); the MCP
    // tools come in via mcpServers and are unaffected. `allowedTools` then
    // auto-approves the bx tools so nothing waits on a permission prompt.
    tools: [],
    allowedTools: BX_TOOL_NAMES,
    permissionMode: "bypassPermissions",
    maxTurns: MAX_TURNS,
    systemPrompt: SYSTEM,
    // Isolation: the driver must not inherit the user's CLAUDE.md, settings, or
    // MCP servers — they would bloat a cheap model's context and change results
    // between machines.
    settingSources: [],
  };

  let turns = 0;
  let usage: AgentUsage = { ...ZERO_USAGE };

  try {
    for await (const message of query({ prompt, options })) {
      if (message.type === "assistant") {
        turns += 1;
      } else if (message.type === "result") {
        usage = {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          cacheReadTokens: message.usage.cache_read_input_tokens,
          costUsd: message.total_cost_usd,
        };
      }
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    if (box.report === null) {
      box.report = { status: "fail", summary: `agent run errored: ${message}`, evidence: [] };
    }
  } finally {
    // A failed attempt must not leak its tab, and a dead daemon must not turn
    // cleanup into the run's outcome.
    await tools.close().catch(() => undefined);
  }

  return { tier, report: box.report, turns, usage };
}

async function saveFlow(
  opts: AgentRunOptions,
  name: string,
  startIndex: number,
): Promise<string | undefined> {
  try {
    const res = await cmd<ActionLogResult>(opts.profile, {
      cmd: "actionLog",
      sinceIndex: startIndex,
    });
    if (!res.ok) return undefined;
    const source = synthesizeFlow(res.data.entries, name);
    const dir = path.resolve(process.cwd(), "flows");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${name}.flow.ts`);
    await writeFile(file, source, "utf8");
    return file;
  } catch {
    return undefined;
  }
}

/** Appended per run so `bx` usage can be audited after the fact. Best effort. */
async function appendRunLog(opts: AgentRunOptions, report: AgentReport): Promise<void> {
  try {
    const dir = path.join(homedir(), BX_DIR_NAME);
    await mkdir(dir, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      instruction: opts.instruction,
      tier: report.tier,
      escalated: report.escalated,
      status: report.status,
      turns: report.turns,
      wallMs: report.wallMs,
      usage: report.usage,
    });
    await appendFile(path.join(dir, "agent-log.jsonl"), `${line}\n`, "utf8");
  } catch {
    // Logging must never fail a run.
  }
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentReport> {
  const started = Date.now();

  // Mark where this run's actions begin, so a synthesized flow contains only
  // what the agent did. A daemon that isn't up yet simply has no history —
  // the first tool call spawns it and the log starts at 0.
  let startIndex = 0;
  try {
    const res = await cmd<ActionLogResult>(opts.profile, { cmd: "actionLog" });
    if (res.ok) startIndex = res.data.nextIndex;
  } catch {
    startIndex = 0;
  }

  const attempts: Attempt[] = [];
  let attempt = await runAttempt(opts, opts.model, null);
  attempts.push(attempt);

  let escalated = false;
  if (opts.model === "haiku" && attempt.report?.status !== "pass") {
    escalated = true;
    attempt = await runAttempt(opts, "sonnet", attempt.report?.summary ?? "none");
    attempts.push(attempt);
  }

  const final: Report = attempt.report ?? {
    status: "fail",
    summary: "agent ended without reporting",
    evidence: [],
  };

  const report: AgentReport = {
    status: final.status,
    summary: final.summary,
    evidence: final.evidence,
    tier: attempt.tier,
    escalated,
    turns: attempts.reduce((n, a) => n + a.turns, 0),
    wallMs: Date.now() - started,
    usage: attempts.reduce<AgentUsage>((u, a) => addUsage(u, a.usage), { ...ZERO_USAGE }),
  };

  if (opts.save !== undefined && report.status === "pass") {
    report.savedFlow = await saveFlow(opts, opts.save, startIndex);
  }

  await appendRunLog(opts, report);
  return report;
}
