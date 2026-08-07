// The natural-language driver: a cheap model operating the browser through the
// bx tools, so the expensive model that called `bx do` never has to.
//
// Cost control is the whole point. Haiku runs first with a tight tool surface
// and no filesystem/bash access; only if it fails to report a pass do we spend
// Sonnet on the same instruction, once. Opus sits one rung further up and is
// never reached unless the caller asked for it.

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

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
  opus: "claude-opus-4-8",
};

const MAX_TURNS = 40;

const AGENT_RUNS_DIR = "agent-runs"; // ~/.bx/agent-runs/<ts>.jsonl
const TOOL_RESULT_MAX_CHARS = 2000;
const VERBOSE_LINE_MAX_CHARS = 160;
const EXHAUSTION_EVIDENCE = 8; // action-log entries attached to a synthesized report
const ESCALATION_ACTIONS = 5; // prior-attempt actions handed to the bigger model

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
  /** What this attempt actually did, from the daemon action log. */
  actions: string[];
}

/** What an escalation is told about the attempt it is replacing. */
interface Prior {
  summary: string;
  actions: string[];
}

// ---------------------------------------------------------------------------
// Transcript. A failed run is only debuggable if every turn was written down,
// so this is always on and always best effort: a run must never fail because
// its transcript could not be written.
// ---------------------------------------------------------------------------

type TranscriptEvent =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; tool: string; input: string }
  | { kind: "tool_result"; text: string; isError: boolean };

interface Transcript {
  path: string;
  write(tier: AgentModel, event: TranscriptEvent): Promise<void>;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function createTranscript(): Transcript {
  const dir = path.join(homedir(), BX_DIR_NAME, AGENT_RUNS_DIR);
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  let ready: Promise<unknown> | null = null;
  return {
    path: file,
    async write(tier: AgentModel, event: TranscriptEvent): Promise<void> {
      try {
        ready ??= mkdir(dir, { recursive: true });
        await ready;
        const line = JSON.stringify({ t: Date.now(), attempt: tier, ...event });
        await appendFile(file, `${line}\n`, "utf8");
      } catch {
        // Never let the record of a run become the reason it fails.
      }
    },
  };
}

/** Tools reach the model as mcp__bx__bx_click; the transcript shows bx_click. */
function toolLabel(name: string): string {
  const prefix = `mcp__${BX_SERVER_NAME}__`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

function verboseLine(tier: AgentModel, event: TranscriptEvent): string {
  const body =
    event.kind === "text"
      ? `say: ${event.text}`
      : event.kind === "tool_call"
        ? `${event.tool} ${event.input}`
        : `→ ${event.text}`;
  return clip(`[${tier}] ${body.replace(/\s+/g, " ").trim()}`, VERBOSE_LINE_MAX_CHARS);
}

type UserMessageContent = Extract<SDKMessage, { type: "user" }>["message"]["content"];

/** Tool results arrive as user-message blocks; text is all the driver can use. */
function toolResultEvents(content: UserMessageContent): TranscriptEvent[] {
  if (typeof content === "string") return [];
  const events: TranscriptEvent[] = [];
  for (const block of content) {
    if (block.type !== "tool_result") continue;
    const parts: string[] = [];
    if (typeof block.content === "string") {
      parts.push(block.content);
    } else if (Array.isArray(block.content)) {
      for (const inner of block.content) if (inner.type === "text") parts.push(inner.text);
    }
    events.push({
      kind: "tool_result",
      text: clip(parts.join("\n"), TOOL_RESULT_MAX_CHARS),
      isError: block.is_error === true,
    });
  }
  return events;
}

/** Where this run's actions start, so evidence covers only what it did. */
async function actionLogNextIndex(profile: string): Promise<number> {
  try {
    const res = await cmd<ActionLogResult>(profile, { cmd: "actionLog" });
    return res.ok ? res.data.nextIndex : 0;
  } catch {
    return 0;
  }
}

async function actionsSince(profile: string, sinceIndex: number, max: number): Promise<string[]> {
  try {
    const res = await cmd<ActionLogResult>(profile, { cmd: "actionLog", sinceIndex });
    if (!res.ok) return [];
    return res.data.entries.slice(-max).map((e) => e.text);
  } catch {
    return [];
  }
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
  prior: Prior | null,
  transcript: Transcript,
): Promise<Attempt> {
  const startIndex = await actionLogNextIndex(opts.profile);

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

  // An escalation that only knows the prior summary re-runs the same failure at
  // a higher price; the actions tell it where the cheap model actually got to.
  const priorActions =
    prior === null || prior.actions.length === 0
      ? ""
      : ` Its last actions: ${prior.actions.join("; ")}.`;
  const prompt =
    prior === null
      ? opts.instruction
      : `A previous attempt by a smaller model did not complete this task (its last report: ${prior.summary}).${priorActions} The browser is in whatever state it left. Start by calling bx_els to orient, then complete the task.\n\n${opts.instruction}`;

  const maxTurns = opts.maxTurns ?? MAX_TURNS;

  const options: Options = {
    model: MODEL_IDS[tier],
    mcpServers: { [BX_SERVER_NAME]: tools.server },
    // `tools: []` drops every built-in (Bash, Read, Edit, WebFetch…); the MCP
    // tools come in via mcpServers and are unaffected. `allowedTools` then
    // auto-approves the bx tools so nothing waits on a permission prompt.
    tools: [],
    allowedTools: BX_TOOL_NAMES,
    permissionMode: "bypassPermissions",
    maxTurns,
    systemPrompt: SYSTEM,
    // Isolation: the driver must not inherit the user's CLAUDE.md, settings, or
    // MCP servers — they would bloat a cheap model's context and change results
    // between machines.
    settingSources: [],
  };

  let turns = 0;
  let usage: AgentUsage = { ...ZERO_USAGE };
  let failure: string | null = null;

  const record = async (event: TranscriptEvent): Promise<void> => {
    if (opts.verbose === true) {
      process.stderr.write(`\x1b[2m${verboseLine(tier, event)}\x1b[0m\n`);
    }
    await transcript.write(tier, event);
  };

  try {
    for await (const message of query({ prompt, options })) {
      if (message.type === "assistant") {
        turns += 1;
        for (const block of message.message.content) {
          if (block.type === "text") {
            if (block.text.trim().length > 0) await record({ kind: "text", text: block.text });
          } else if (block.type === "tool_use") {
            await record({
              kind: "tool_call",
              tool: toolLabel(block.name),
              input: JSON.stringify(block.input),
            });
          }
        }
      } else if (message.type === "user") {
        for (const event of toolResultEvents(message.message.content)) await record(event);
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
    failure = e instanceof Error ? e.message : String(e);
  } finally {
    // A failed attempt must not leak its tab, and a dead daemon must not turn
    // cleanup into the run's outcome.
    await tools.close().catch(() => undefined);
  }

  const actions = await actionsSince(opts.profile, startIndex, EXHAUSTION_EVIDENCE);

  // An attempt that ends without calling bx_report is the black box this whole
  // file exists to avoid: synthesize the report the model owed us, with what it
  // did as evidence. Turn exhaustion surfaces as a thrown SDK error, so the
  // message decides which of the two summaries applies.
  if (box.report === null) {
    const exhausted = failure === null || /maximum number of turns/i.test(failure);
    box.report = {
      status: "fail",
      summary: exhausted
        ? `ran out of turns (${maxTurns}) without reporting — see transcript`
        : `agent run errored: ${failure}`,
      evidence: actions,
    };
  }

  return { tier, report: box.report, turns, usage, actions };
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
  const startIndex = await actionLogNextIndex(opts.profile);

  // One file per run: both tiers append to it, tagged by attempt.
  const transcript = createTranscript();

  const attempts: Attempt[] = [];
  let attempt = await runAttempt(opts, opts.model, null, transcript);
  attempts.push(attempt);

  // The ladder above the starting tier: haiku always gets one Sonnet retry,
  // and Opus is only ever reached when the caller opted in. Built from the
  // starting tier so a run never escalates past where the caller began.
  const ladder: AgentModel[] = [];
  if (opts.model === "haiku") ladder.push("sonnet");
  if (opts.escalateOpus === true && opts.model !== "opus") ladder.push("opus");

  for (const tier of ladder) {
    if (attempt.report?.status === "pass") break;
    const prior: Prior = {
      summary: attempt.report?.summary ?? "none",
      actions: attempt.actions.slice(-ESCALATION_ACTIONS),
    };
    attempt = await runAttempt(opts, tier, prior, transcript);
    attempts.push(attempt);
  }
  const escalated = attempts.length > 1;

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
    transcriptPath: transcript.path,
  };

  if (opts.save !== undefined && report.status === "pass") {
    report.savedFlow = await saveFlow(opts, opts.save, startIndex);
  }

  await appendRunLog(opts, report);
  return report;
}
