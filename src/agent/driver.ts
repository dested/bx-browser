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

// USD per million tokens, per tier. Only used for mid-run governance — the
// trailer still prefers the SDK's own cost when it reports one.
const PRICING: Record<AgentModel, { input: number; output: number }> = {
  haiku: { input: 1, output: 5 },
  sonnet: { input: 3, output: 15 },
  opus: { input: 5, output: 25 },
};
const CACHE_READ_RATE = 0.1; // cache reads bill at a tenth of the input rate
const CACHE_WRITE_RATE = 1.25; // cache writes bill at 125% of the input rate

const AGENT_RUNS_DIR = "agent-runs"; // ~/.bx/agent-runs/<ts>.jsonl
const TOOL_RESULT_MAX_CHARS = 2000;
const VERBOSE_LINE_MAX_CHARS = 160;
const EXHAUSTION_EVIDENCE = 8; // action-log entries attached to a synthesized report
const ESCALATION_ACTIONS = 5; // prior-attempt actions handed to the bigger model
const STALL_WINDOW = 8; // tool calls examined for repetition
const STALL_DISTINCT = 3; // at or below this many distinct calls in the window = stuck
const STALL_EVIDENCE = 4; // distinct repeated calls named in the stall report
const HEARTBEAT_TURNS = 10;
const HEARTBEAT_INPUT_MAX_CHARS = 48;

const SYSTEM = `You are bx-driver, operating a real browser through bx tools. You cannot see the screen; you see distilled text. Work fast and precisely.
Method: (1) bx_open the target URL, or bx_els to see the current page. (2) Element lists show numbered refs like [3] button "Save" — act on them by passing the number as target, or pass visible text / a data-testid. (3) After any action that changes the page, the result tells you; call bx_els again only when you need fresh refs. (4) Verify every task outcome with bx_expect before reporting. (5) If a target is not found, read the 'did you mean' candidates and retry once with the best one. (6) Check bx_console if something seems broken.
Canvas/games: when the page is a canvas with no useful elements, act by coordinates — bx_mouse/bx_drag/bx_key with in set to the canvas testid so x/y are relative to its top-left; hold movement keys with bx_key down then up. You cannot see the canvas: read state the app exposes via bx_js (e.g. window.__game) and verify outcomes with bx_js too — bx_expect only sees DOM text.
Finding targets on a canvas: you cannot see it, so never guess pixel positions for an unlabeled target. First map the app's exposed handles — bx_js Object.keys(window).filter(k => k.startsWith('__')) — then explore the promising one (Object.keys, .getState?.()). Prefer calling an app navigation/store action or opening a deep-link URL via bx_js over blind coordinate clicks; coordinates are for targets whose position you actually know from the task, from state, or from element-relative geometry.
Real-time games: turn-based per-key play CANNOT win a 60fps game — by the time you read state and press a key the game has moved on. Use bx_drive: (1) find the app's per-frame input hook in its exposed state; (2) dump ONE sample of the full input shape it accepts — buttons AND axes, a joystick-only controller cannot win a game whose jump/flap is a button, and buttons may be edge-triggered: if holding one has no effect, pulse it every few frames; (3) infer roles from instance counts (1-of = hero, N-of = collectibles or hazards); (4) bx_drive installs your controller and polls the win signal entirely in-page, zero turns while it plays; (5) on timeout, revise the controller and call bx_drive again — it replaces the old one without restarting the game.
Rules: never invent selectors; prefer testids and visible text. Keep to the task — do not explore. When the task is done (or truly impossible), call bx_report exactly once with status, a 2–3 sentence summary, and evidence (assertions passed, final URL). Then stop.`;

type Report = { status: "pass" | "fail"; summary: string; evidence: string[] };

type EndedBy = NonNullable<AgentReport["endedBy"]>;

interface Attempt {
  tier: AgentModel;
  report: Report | null;
  turns: number;
  usage: AgentUsage;
  /** What this attempt actually did, from the daemon action log. */
  actions: string[];
  endedBy: EndedBy;
  /** Last page URL this attempt reached; the next rung starts there. */
  lastUrl?: string;
  /** Tab this attempt drove; what scopes the shared action log back to it. */
  tabId?: number;
}

/** What an escalation is told about the attempt it is replacing. */
interface Prior {
  summary: string;
  actions: string[];
  lastUrl?: string;
}

// ---------------------------------------------------------------------------
// Governance. Spend, wall clock and turn count are properties of the whole
// ladder, not of one rung — a budget the first rung nearly exhausts must not
// reset when the escalation starts.
// ---------------------------------------------------------------------------

interface RunState {
  started: number;
  estUsd: number;
  turns: number;
}

type AssistantUsage = Extract<SDKMessage, { type: "assistant" }>["message"]["usage"];

function messageCostUsd(tier: AgentModel, usage: AssistantUsage): number {
  const price = PRICING[tier];
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreate = usage.cache_creation_input_tokens ?? 0;
  const input =
    usage.input_tokens * price.input +
    cacheRead * price.input * CACHE_READ_RATE +
    cacheCreate * price.input * CACHE_WRITE_RATE;
  return (input + usage.output_tokens * price.output) / 1_000_000;
}

interface Ceiling {
  kind: "budget" | "wall";
  summary: string;
}

function wallCeilingSummary(maxWallMs: number): string {
  return `aborted: wall ceiling ${Math.round(maxWallMs / 1000)}s reached`;
}

function ceilingHit(opts: AgentRunOptions, run: RunState): Ceiling | null {
  const { budgetUsd, maxWallMs } = opts;
  if (budgetUsd !== undefined && run.estUsd >= budgetUsd) {
    return {
      kind: "budget",
      summary: `aborted: budget ceiling $${budgetUsd} reached (est $${run.estUsd.toFixed(4)} spent)`,
    };
  }
  if (maxWallMs !== undefined && Date.now() - run.started >= maxWallMs) {
    return { kind: "wall", summary: wallCeilingSummary(maxWallMs) };
  }
  return null;
}

/** A full window holding almost no distinct calls is a model going in circles. */
function stalledCalls(recent: string[], window: number): string[] | null {
  if (window <= 0 || recent.length < window) return null;
  const counts = new Map<string, number>();
  for (const call of recent) counts.set(call, (counts.get(call) ?? 0) + 1);
  if (counts.size > STALL_DISTINCT) return null;
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, STALL_EVIDENCE)
    .map(([call, n]) => `${clip(call, HEARTBEAT_INPUT_MAX_CHARS)} ×${n}`);
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

/** `tab` keeps a concurrent run's actions out of this one's evidence. */
async function actionsSince(
  profile: string,
  sinceIndex: number,
  max: number,
  tab: number | undefined,
): Promise<string[]> {
  try {
    const res = await cmd<ActionLogResult>(profile, { cmd: "actionLog", sinceIndex });
    if (!res.ok) return [];
    const entries =
      tab === undefined ? res.data.entries : res.data.entries.filter((e) => e.tab === tab);
    return entries.slice(-max).map((e) => e.text);
  } catch {
    return [];
  }
}

// JSON forms a truthy win predicate can never take. A pass whose predicate
// renders as one of these is the model claiming an outcome the page denies.
const FALSY_JSON = new Set(["false", "null", "undefined", "0", '""']);

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
  run: RunState,
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
  // and two concurrent runs never share one. Handing that tab the URL the last
  // rung reached is what makes the "orient yourself" instruction below true.
  const tools = createBxTools(opts.profile, sink, prior?.lastUrl ?? opts.startUrl);

  // An escalation that only knows the prior summary re-runs the same failure at
  // a higher price; the actions tell it where the cheap model actually got to.
  const priorActions =
    prior === null || prior.actions.length === 0
      ? ""
      : ` Its last actions: ${prior.actions.join("; ")}.`;
  const orient =
    prior?.lastUrl === undefined
      ? "The browser is in whatever state it left. Start by calling bx_els to orient, then complete the task."
      : `You start in a fresh tab already open at ${prior.lastUrl} (where the previous attempt ended). Call bx_els to orient, then continue.`;
  // The entry recipe runs per rung, not per run: an escalation gets a fresh tab
  // and no in-page state survives that.
  let setup = "";
  if (opts.enterJs !== undefined) {
    const entry = await tools.runJs(`(async () => { ${opts.enterJs} ; return "entered" })()`);
    setup = entry.ok
      ? `Setup already ran in your tab: \`${opts.enterJs}\` → ${entry.value}. `
      : `Setup JS was attempted but threw: ${entry.value} — recover or report fail. `;
  }
  const win =
    opts.winExpr === undefined
      ? ""
      : ` The task's success predicate: bx_js \`${opts.winExpr}\` must be truthy. Poll it; report pass only once it is truthy.`;
  const base =
    prior === null
      ? opts.instruction
      : `A previous attempt by a smaller model did not complete this task (its last report: ${prior.summary}).${priorActions} ${orient}\n\n${opts.instruction}`;
  const prompt = `${setup}${base}${win}`;

  const maxTurns = opts.maxTurns ?? MAX_TURNS;
  const stallWindow = opts.stallWindow ?? STALL_WINDOW;
  const heartbeatTurns = opts.heartbeatTurns ?? HEARTBEAT_TURNS;

  // The SDK's own cancellation path: abort, then break, so the session is torn
  // down rather than left to finish a turn nobody is going to read.
  const controller = new AbortController();

  const options: Options = {
    abortController: controller,
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
  // Every completed rung re-anchors the ladder-wide estimate to metered truth,
  // so per-message pricing drift cannot compound across escalations.
  const rungBase = run.estUsd;
  let usage: AgentUsage = { ...ZERO_USAGE };
  let failure: string | null = null;
  let stopped: { by: EndedBy; summary: string; extra: string[] } | null = null;
  let last = "(no tool calls yet)";
  const recent: string[] = []; // sliding window of (tool, input) pairs

  // Spend can only be reassessed when a message arrives, but the clock cannot
  // wait for one — a turn in flight would push the wall ceiling past itself.
  const maxWallMs = opts.maxWallMs;
  const wallTimer =
    maxWallMs === undefined
      ? null
      : setTimeout(
          () => {
            stopped ??= { by: "wall", summary: wallCeilingSummary(maxWallMs), extra: [] };
            controller.abort();
          },
          Math.max(0, maxWallMs - (Date.now() - run.started)),
        );

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
        run.turns += 1;
        run.estUsd += messageCostUsd(tier, message.message.usage);
        for (const block of message.message.content) {
          if (block.type === "text") {
            if (block.text.trim().length === 0) continue;
            last = clip(block.text.replace(/\s+/g, " ").trim(), HEARTBEAT_INPUT_MAX_CHARS);
            await record({ kind: "text", text: block.text });
          } else if (block.type === "tool_use") {
            const tool = toolLabel(block.name);
            const input = JSON.stringify(block.input);
            last = clip(`${tool} ${input}`, HEARTBEAT_INPUT_MAX_CHARS);
            if (stallWindow > 0) {
              recent.push(`${tool} ${input}`);
              if (recent.length > stallWindow) recent.shift();
            }
            await record({ kind: "tool_call", tool, input });
          }
        }
        if (heartbeatTurns > 0 && run.turns % heartbeatTurns === 0) {
          process.stdout.write(
            `… turn ${run.turns} · ~$${run.estUsd.toFixed(2)} · last: ${last}\n`,
          );
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
        if (typeof message.total_cost_usd === "number") {
          run.estUsd = rungBase + message.total_cost_usd;
        }
      }

      // A model that has already reported is one message from stopping on its
      // own; only an unreported run is worth cutting short.
      if (box.report !== null) continue;
      if (stopped !== null) break; // the wall timer got there first
      const ceiling = ceilingHit(opts, run);
      if (ceiling !== null) {
        stopped = { by: ceiling.kind, summary: ceiling.summary, extra: [] };
      } else {
        const repeated = stalledCalls(recent, stallWindow);
        if (repeated !== null) {
          stopped = {
            by: "stall",
            summary: "stalled: repeating the same actions with no progress",
            extra: [`repeated in the last ${stallWindow} calls: ${repeated.join(", ")}`],
          };
        }
      }
      if (stopped !== null) {
        controller.abort();
        break;
      }
    }
  } catch (e: unknown) {
    // An abort we asked for is not a failure — the ending is already decided.
    if (stopped === null) failure = e instanceof Error ? e.message : String(e);
  } finally {
    if (wallTimer !== null) clearTimeout(wallTimer);
    // A reported pass is a claim; the predicate is the evidence. Checked here,
    // while the tab this run drove is still open.
    const claimed = box.report;
    if (opts.winExpr !== undefined && claimed?.status === "pass") {
      const v = await tools.runJs(opts.winExpr);
      if (!v.ok) {
        // Tab gone or the expression threw: unverifiable is not disproved.
        claimed.evidence.push(`win predicate could not be verified: ${v.value}`);
      } else if (FALSY_JSON.has(v.value)) {
        box.report = {
          status: "fail",
          summary: `model reported pass but the win predicate evaluated ${v.value}: ${opts.winExpr}`,
          evidence: [...claimed.evidence],
        };
      } else {
        claimed.evidence.push(`win predicate verified: ${opts.winExpr} → ${v.value}`);
      }
    }
    // A failed attempt must not leak its tab, and a dead daemon must not turn
    // cleanup into the run's outcome.
    await tools.close().catch(() => undefined);
  }

  const actions = await actionsSince(opts.profile, startIndex, EXHAUSTION_EVIDENCE, tools.tabId());

  // An attempt that ends without calling bx_report is the black box this whole
  // file exists to avoid: synthesize the report the model owed us, with what it
  // did as evidence. Turn exhaustion surfaces as a thrown SDK error, so the
  // message decides which of the two summaries applies.
  let endedBy: EndedBy;
  if (box.report !== null) {
    endedBy = "report";
  } else if (stopped !== null) {
    endedBy = stopped.by;
    box.report = {
      status: "fail",
      summary: stopped.summary,
      evidence: [...stopped.extra, ...actions],
    };
  } else {
    const exhausted = failure === null || /maximum number of turns/i.test(failure);
    endedBy = exhausted ? "turns" : "error";
    box.report = {
      status: "fail",
      summary: exhausted
        ? `ran out of turns (${maxTurns}) without reporting — see transcript`
        : `agent run errored: ${failure}`,
      evidence: actions,
    };
  }

  return {
    tier,
    report: box.report,
    turns,
    usage,
    actions,
    endedBy,
    lastUrl: tools.lastUrl(),
    tabId: tools.tabId(),
  };
}

/** `tabIds` — every tab this run drove; anything else in the log belongs to someone else. */
async function saveFlow(
  opts: AgentRunOptions,
  name: string,
  startIndex: number,
  tabIds: ReadonlySet<number>,
): Promise<string | undefined> {
  try {
    const res = await cmd<ActionLogResult>(opts.profile, {
      cmd: "actionLog",
      sinceIndex: startIndex,
    });
    if (!res.ok) return undefined;
    const entries =
      tabIds.size === 0
        ? res.data.entries
        : res.data.entries.filter((e) => e.tab !== undefined && tabIds.has(e.tab));
    const source = synthesizeFlow(entries, name);
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
async function appendRunLog(
  opts: AgentRunOptions,
  report: AgentReport,
  estUsd: number,
): Promise<void> {
  try {
    const dir = path.join(homedir(), BX_DIR_NAME);
    await mkdir(dir, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      instruction: opts.instruction,
      tier: report.tier,
      escalated: report.escalated,
      status: report.status,
      endedBy: report.endedBy,
      turns: report.turns,
      wallMs: report.wallMs,
      usage: report.usage,
      estUsd,
    });
    await appendFile(path.join(dir, "agent-log.jsonl"), `${line}\n`, "utf8");
  } catch {
    // Logging must never fail a run.
  }
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentReport> {
  const started = Date.now();
  const run: RunState = { started, estUsd: 0, turns: 0 };

  // Mark where this run's actions begin, so a synthesized flow contains only
  // what the agent did. A daemon that isn't up yet simply has no history —
  // the first tool call spawns it and the log starts at 0.
  const startIndex = await actionLogNextIndex(opts.profile);

  // One file per run: both tiers append to it, tagged by attempt.
  const transcript = createTranscript();

  const attempts: Attempt[] = [];
  let attempt = await runAttempt(opts, opts.model, null, transcript, run);
  attempts.push(attempt);

  // The ladder above the starting tier: haiku always gets one Sonnet retry,
  // and Opus is only ever reached when the caller opted in. Built from the
  // starting tier so a run never escalates past where the caller began.
  const ladder: AgentModel[] = [];
  if (opts.model === "haiku") ladder.push("sonnet");
  if (opts.escalateOpus === true && opts.model !== "opus") ladder.push("opus");

  for (const tier of ladder) {
    if (attempt.report?.status === "pass") break;
    // A ceiling ends the run, not just the rung: escalating past a spend or
    // wall limit is exactly the runaway the limit exists to prevent.
    if (ceilingHit(opts, run) !== null) break;
    const prior: Prior = {
      summary: attempt.report?.summary ?? "none",
      actions: attempt.actions.slice(-ESCALATION_ACTIONS),
      lastUrl: attempt.lastUrl,
    };
    attempt = await runAttempt(opts, tier, prior, transcript, run);
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
    endedBy: attempt.endedBy,
    estUsd: run.estUsd,
  };

  if (opts.save !== undefined && report.status === "pass") {
    const tabIds = new Set(
      attempts.map((a) => a.tabId).filter((id): id is number => id !== undefined),
    );
    report.savedFlow = await saveFlow(opts, opts.save, startIndex, tabIds);
  }

  await appendRunLog(opts, report, run.estUsd);
  return report;
}
