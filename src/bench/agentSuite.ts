// The agent bench: a fixed set of browser tasks run through `bx agent` at a
// chosen tier, each checked by the bench itself (never by the model's own
// report), so pass rate, turns and cost per tier are numbers rather than
// impressions. It is what decides the escalation ladder and the numbers
// SKILL.md quotes.
//
//   bun src/bench/bench.ts --agent-suite [--tier haiku[,sonnet,opus,ladder]]
//     [--tasks <n>|<id,id,…>] [--repeat <n>] [--budget <usd>] [--max-wall <s>]
//     [--profile <p>] [--headed] [--max-total <usd>] [--commit <sha>]
//
// --max-total stops the suite once the summed estimate crosses it; the
// results written are then marked partial.
//
// Spends real tokens: every task is one full agent run per tier per repeat.
// Results land in bench-agent-results.json at the repo root.
//
// Tasks run one at a time: the TaskBox fixture keeps its state in the
// daemon origin's localStorage, which every tab shares.

import * as path from "node:path";

import { cmd, ensureDaemon, setClientVia, stopDaemon } from "../client.ts";
import { runAgent } from "../agent/driver.ts";
import { MODEL_IDS, PRICES_CHECKED } from "../agent/pricing.ts";
import type { AgentModel, AgentReport, Cmd, CmdResult, JsResult, TabsResult } from "../protocol.ts";

// ---------------------------------------------------------------------------
// Bench pages: a tiny server for the cases the TaskBox fixture lacks (modal,
// custom select, popup, filtering, infinite scroll). Pages report what the
// agent did to /api/event/<page>; checks read it back here.
// ---------------------------------------------------------------------------

const PAGES_DIR = path.join(import.meta.dir, "pages");

interface PageServer {
  base: string;
  events(page: string): unknown[];
  supportCode(): string;
  reset(): void;
  stop(): void;
}

export function startPageServer(): PageServer {
  const events = new Map<string, unknown[]>();
  let code = "";
  const reset = (): void => {
    events.clear();
    // Fresh per task: a model cannot carry a code over from an earlier run.
    code = `K${Math.floor(Math.random() * 90 + 10)}-${["PLUM", "FERN", "OPAL", "MOSS"][Math.floor(Math.random() * 4)]}-${Math.floor(Math.random() * 900 + 100)}`;
  };
  reset();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname === "/api/code") return Response.json({ code });
      const event = /^\/api\/event\/([a-z-]+)$/.exec(url.pathname);
      if (event?.[1] !== undefined && req.method === "POST") {
        let body: unknown;
        try {
          body = JSON.parse(await req.text());
        } catch {
          return new Response("bad json", { status: 400 });
        }
        const list = events.get(event[1]) ?? [];
        list.push(body);
        events.set(event[1], list);
        return new Response(null, { status: 204 });
      }
      const name = url.pathname.replace(/^\/+/, "");
      if (!/^[a-z-]+\.(html|css)$/.test(name)) return new Response("not found", { status: 404 });
      const file = Bun.file(path.join(PAGES_DIR, name));
      return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
    },
  });
  return {
    base: `http://127.0.0.1:${server.port}`,
    events: (page) => events.get(page) ?? [],
    supportCode: () => code,
    reset,
    stop: () => void server.stop(true),
  };
}

// ---------------------------------------------------------------------------
// Fixture state: TaskBox lives in localStorage on the daemon's origin. The
// bench seeds and reads it through a background tab of its own.
// ---------------------------------------------------------------------------

export interface Env {
  profile: string;
  fixture: string; // http://127.0.0.1:<daemon>/fixture
  pages: PageServer;
}

async function send<T>(profile: string, c: Cmd): Promise<T> {
  const res: CmdResult<T> = await cmd<T>(profile, c);
  if (!res.ok) throw new Error(`${c.cmd} failed: ${res.error.code} — ${res.error.message}`);
  return res.data;
}

/** Runs `js` in a throwaway background tab on the fixture origin; returns the JSON value. */
async function fixtureJs(env: Env, js: string): Promise<string> {
  const tabs = await send<TabsResult>(env.profile, { cmd: "tabNew", url: env.fixture, background: true });
  const tab = tabs.created?.id;
  if (tab === undefined) throw new Error("tabNew made no tab");
  try {
    return (await send<JsResult>(env.profile, { cmd: "js", expression: js, tab })).value;
  } finally {
    await cmd<TabsResult>(env.profile, { cmd: "tabClose", tab }).catch(() => undefined);
  }
}

interface FixtureSeed {
  authed: boolean;
  tasks?: string[];
}

async function seedFixture(env: Env, seed: FixtureSeed): Promise<void> {
  const lines = [
    "localStorage.clear()",
    seed.authed ? `localStorage.setItem("taskbox.auth", "1")` : "",
    `localStorage.setItem("taskbox.tasks", ${JSON.stringify(JSON.stringify(seed.tasks ?? []))})`,
    `localStorage.setItem("taskbox.dark", "0")`,
    "true",
  ];
  await fixtureJs(env, lines.filter((l) => l !== "").join(";\n"));
}

async function fixtureStore(env: Env): Promise<Record<string, string>> {
  const raw = await fixtureJs(env, "Object.fromEntries(Object.entries(localStorage))");
  const parsed: unknown = JSON.parse(raw);
  const out: Record<string, string> = {};
  if (typeof parsed === "object" && parsed !== null) {
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k] = v;
  }
  return out;
}

function storedTasks(store: Record<string, string>): string[] {
  try {
    const v: unknown = JSON.parse(store["taskbox.tasks"] ?? "[]");
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

interface Verdict {
  pass: boolean;
  detail: string;
}

export interface BenchTask {
  id: string;
  /** What the suite covers with it, for the results file. */
  covers: string;
  instruction(env: Env): string;
  startUrl?(env: Env): string;
  winExpr?: string;
  setup(env: Env): Promise<void>;
  check(env: Env, report: AgentReport): Promise<Verdict>;
}

function reportText(r: AgentReport): string {
  return [r.summary, ...r.evidence].join("\n").toLowerCase();
}

function said(r: AgentReport, needle: string): Verdict {
  const pass = reportText(r).includes(needle.toLowerCase());
  return { pass, detail: pass ? `report quotes "${needle}"` : `report never says "${needle}"` };
}

function equalList(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export const TASKS: BenchTask[] = [
  {
    id: "login",
    covers: "fill + click + verify on a login form",
    instruction: (e) =>
      `Log in to ${e.fixture} as demo@taskbox.test with password hunter2, and verify you land on the task list.`,
    setup: (e) => seedFixture(e, { authed: false }),
    async check(e) {
      const store = await fixtureStore(e);
      const pass = store["taskbox.auth"] === "1";
      return { pass, detail: pass ? "signed in" : "taskbox.auth not set" };
    },
  },
  {
    id: "add-task",
    covers: "fill + submit, list grows",
    instruction: (e) => `On ${e.fixture}, add a task called "Buy oat milk" and verify it shows in the list.`,
    setup: (e) => seedFixture(e, { authed: true, tasks: ["Walk the dog"] }),
    async check(e) {
      const tasks = storedTasks(await fixtureStore(e));
      const pass = equalList(tasks, ["Walk the dog", "Buy oat milk"]);
      return { pass, detail: `tasks: ${JSON.stringify(tasks)}` };
    },
  },
  {
    id: "delete-task",
    covers: "pick one row's button among identical ones",
    instruction: (e) => `On ${e.fixture}, delete the task "Pay rent" and leave the other tasks alone.`,
    setup: (e) => seedFixture(e, { authed: true, tasks: ["Walk the dog", "Pay rent", "Call mom"] }),
    async check(e) {
      const tasks = storedTasks(await fixtureStore(e));
      const pass = equalList(tasks, ["Walk the dog", "Call mom"]);
      return { pass, detail: `tasks: ${JSON.stringify(tasks)}` };
    },
  },
  {
    id: "dark-mode",
    covers: "navigate + checkbox toggle + save",
    instruction: (e) => `On ${e.fixture}, turn on dark mode in Settings and save the settings.`,
    setup: (e) => seedFixture(e, { authed: true }),
    async check(e) {
      const store = await fixtureStore(e);
      const pass = store["taskbox.dark"] === "1";
      return { pass, detail: `taskbox.dark=${store["taskbox.dark"] ?? "unset"}` };
    },
  },
  {
    id: "slow-widget",
    covers: "wait for late content (1.5 s)",
    instruction: (e) =>
      `On ${e.fixture}, load the slow widget on the Tasks page and report the exact text the widget shows once it has loaded.`,
    setup: (e) => seedFixture(e, { authed: true }),
    check: async (_e, r) => said(r, "Widget loaded"),
  },
  {
    id: "console-error",
    covers: "console reading",
    instruction: (e) =>
      `On ${e.fixture}, press "Trigger error" on the Tasks page and report the console error it logs, word for word.`,
    setup: (e) => seedFixture(e, { authed: true }),
    check: async (_e, r) => said(r, "TaskBox: simulated failure"),
  },
  {
    id: "modal",
    covers: "confirm dialog whose button shares its label with the page behind",
    instruction: (e) =>
      `On ${e.pages.base}/modal.html, delete the project named Gamma (confirm the dialog). Leave the other projects alone.`,
    setup: async (e) => e.pages.reset(),
    async check(e) {
      const deleted = e.pages.events("modal").map((v) => (isRecord(v) ? v["deleted"] : undefined));
      const pass = equalList(deleted, ["Gamma"]);
      return { pass, detail: `deleted: ${JSON.stringify(deleted)}` };
    },
  },
  {
    id: "select",
    covers: "native <select> + custom listbox + checkbox",
    instruction: (e) =>
      `On ${e.pages.base}/select.html, place an order shipping to Canada, size Large, with express shipping.`,
    setup: async (e) => e.pages.reset(),
    async check(e) {
      const orders = e.pages.events("select");
      const last = orders[orders.length - 1];
      const pass =
        orders.length === 1 &&
        isRecord(last) &&
        last["country"] === "CA" &&
        last["size"] === "Large" &&
        last["express"] === true;
      return { pass, detail: `orders: ${JSON.stringify(orders)}` };
    },
  },
  {
    id: "popup",
    covers: "information only in a popup tab",
    instruction: (e) =>
      `On ${e.pages.base}/popup.html, open the help center, read the support code it shows, then submit that code with the support form on the original page.`,
    setup: async (e) => e.pages.reset(),
    async check(e) {
      const codes = e.pages.events("popup").map((v) => (isRecord(v) ? v["code"] : undefined));
      const pass = codes.length > 0 && codes[codes.length - 1] === e.pages.supportCode();
      return { pass, detail: `submitted ${JSON.stringify(codes)}, wanted ${e.pages.supportCode()}` };
    },
  },
  {
    id: "filter",
    covers: "filter + read prices + pick the minimum",
    instruction: (e) =>
      `On ${e.pages.base}/filter.html, add the cheapest Garden product to the cart. Add exactly one item.`,
    setup: async (e) => e.pages.reset(),
    async check(e) {
      const added = e.pages.events("filter").map((v) => (isRecord(v) ? v["added"] : undefined));
      const pass = equalList(added, ["Seed tray"]);
      return { pass, detail: `added: ${JSON.stringify(added)}` };
    },
  },
  {
    id: "scroll",
    covers: "infinite scroll to an element not yet in the DOM",
    instruction: (e) =>
      `On ${e.pages.base}/scroll.html, star post #57. The feed loads more posts as you scroll down.`,
    setup: async (e) => e.pages.reset(),
    async check(e) {
      const stars = e.pages.events("scroll").filter(isRecord);
      const on = new Set<unknown>();
      for (const s of stars) {
        if (s["starred"] === true) on.add(s["post"]);
        else on.delete(s["post"]);
      }
      const pass = on.size === 1 && on.has(57);
      return { pass, detail: `starred: ${JSON.stringify([...on])}` };
    },
  },
  {
    id: "game-drive",
    covers: "real-time canvas: in-page controller via drive, --url/--win",
    instruction: () =>
      "Move the yellow square on the game canvas to x=300, y=200 (within 6 px) and leave it there. window.__game.player holds its position; window.__game.keys holds pressed keys (w/a/s/d move it 2 px per frame).",
    startUrl: (e) => `${e.fixture}#/game`,
    winExpr: "Math.hypot(window.__game.player.x - 300, window.__game.player.y - 200) <= 6",
    setup: (e) => seedFixture(e, { authed: true }),
    // The driver itself checks --win before accepting a pass (the game state
    // dies with the agent's tab, so the bench cannot read it afterwards).
    async check(_e, r) {
      const pass = r.status === "pass" && r.evidence.some((x) => x.startsWith("win predicate verified"));
      return { pass, detail: pass ? "win predicate verified by the driver" : r.summary };
    },
  },
];

// ---------------------------------------------------------------------------
// Run + results
// ---------------------------------------------------------------------------

type Tier = AgentModel | "ladder"; // ladder = haiku with the CLI's default escalation

const TIERS: readonly Tier[] = ["haiku", "sonnet", "opus", "ladder"];

function isTier(s: string): s is Tier {
  return (TIERS as readonly string[]).includes(s);
}

interface TaskRun {
  task: string;
  tier: Tier;
  repeat: number;
  pass: boolean;
  /** The model reported pass but the bench's check failed. */
  falsePass: boolean;
  detail: string;
  status: AgentReport["status"];
  endedBy: AgentReport["endedBy"];
  finalTier: AgentModel;
  escalated: boolean;
  turns: number;
  wallMs: number;
  /** pricing.ts applied to the run's metered tokens: the number to trust. */
  estUsd: number;
  /** The SDK's own figure, from its bundled (possibly stale) price table. */
  sdkUsd: number | null;
  transcript?: string;
}

interface TierSummary {
  runs: number;
  passed: number;
  passRate: number;
  falsePasses: number;
  medianTurns: number;
  p90Turns: number;
  medianWallMs: number;
  /** pricing.ts prices on metered tokens. */
  totalUsd: number;
  /** The same runs at the SDK's own prices, for comparison. */
  sdkTotalUsd: number | null;
  usdPerRun: number;
  usdPerPass: number | null;
  endedBy: Record<string, number>;
  escalations: number;
}

interface SuiteResults {
  date: string;
  pricesChecked: string;
  models: Record<AgentModel, string>;
  commit: string;
  profile: string;
  headless: boolean;
  tasks: string[];
  repeat: number;
  budgetUsd: number;
  maxWallMs: number;
  partial: boolean;
  tiers: Partial<Record<Tier, TierSummary>>;
  runs: TaskRun[];
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[i] ?? 0;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  const hi = s[mid] ?? 0;
  return s.length % 2 === 1 ? hi : ((s[mid - 1] ?? 0) + hi) / 2;
}

function summarize(runs: TaskRun[]): TierSummary {
  const passed = runs.filter((r) => r.pass).length;
  const totalUsd = runs.reduce((n, r) => n + r.estUsd, 0);
  const sdk = runs.map((r) => r.sdkUsd);
  const endedBy: Record<string, number> = {};
  for (const r of runs) {
    const k = r.endedBy ?? "unknown";
    endedBy[k] = (endedBy[k] ?? 0) + 1;
  }
  const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;
  return {
    runs: runs.length,
    passed,
    passRate: runs.length === 0 ? 0 : Math.round((passed / runs.length) * 1000) / 1000,
    falsePasses: runs.filter((r) => r.falsePass).length,
    medianTurns: median(runs.map((r) => r.turns)),
    p90Turns: quantile(runs.map((r) => r.turns), 0.9),
    medianWallMs: Math.round(median(runs.map((r) => r.wallMs))),
    totalUsd: round4(totalUsd),
    sdkTotalUsd: sdk.every((v): v is number => v !== null) ? round4(sdk.reduce((n, v) => n + v, 0)) : null,
    usdPerRun: runs.length === 0 ? 0 : round4(totalUsd / runs.length),
    usdPerPass: passed === 0 ? null : round4(totalUsd / passed),
    endedBy,
    escalations: runs.filter((r) => r.escalated).length,
  };
}

/** A git archive export has no .git: `--commit <sha>` names what was exported. */
function commitSha(override: string | undefined): string {
  if (override !== undefined) return override;
  const r = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
    cwd: path.join(import.meta.dir, "../.."),
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  return r.exitCode === 0 ? r.stdout.toString().trim() : "unknown";
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface SuiteArgs {
  profile: string;
  headless: boolean;
  tiers: Tier[];
  tasks: BenchTask[];
  repeat: number;
  budgetUsd: number;
  maxWallMs: number;
  maxTotalUsd: number | undefined;
  commit: string | undefined;
}

const DEFAULT_BUDGET_USD = 1;
const DEFAULT_MAX_WALL_S = 240;

function parseSuiteArgs(argv: string[]): SuiteArgs {
  const value = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const positive = (name: string, fallback: number): number => {
    const raw = value(name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} needs a positive number, got "${raw}"`);
    return n;
  };

  const tiers: Tier[] = [];
  for (const t of (value("tier") ?? "haiku").split(",")) {
    if (!isTier(t)) throw new Error(`unknown tier "${t}" — use ${TIERS.join(", ")}`);
    tiers.push(t);
  }

  let tasks = TASKS;
  const pick = value("tasks");
  if (pick !== undefined) {
    if (/^\d+$/.test(pick)) {
      tasks = TASKS.slice(0, Number(pick));
    } else {
      tasks = pick.split(",").map((id) => {
        const t = TASKS.find((x) => x.id === id);
        if (t === undefined) throw new Error(`unknown task "${id}" — tasks: ${TASKS.map((x) => x.id).join(", ")}`);
        return t;
      });
    }
  }
  if (tasks.length === 0) throw new Error("no tasks selected");

  return {
    profile: value("profile") ?? "bxbench",
    headless: !argv.includes("--headed"),
    tiers,
    tasks,
    repeat: Math.floor(positive("repeat", 1)),
    budgetUsd: positive("budget", DEFAULT_BUDGET_USD),
    maxWallMs: positive("max-wall", DEFAULT_MAX_WALL_S) * 1000,
    maxTotalUsd: value("max-total") === undefined ? undefined : positive("max-total", 0),
    commit: value("commit"),
  };
}

function line(r: TaskRun): string {
  const cost = `$${r.estUsd.toFixed(4)}${r.sdkUsd === null ? "" : ` (sdk $${r.sdkUsd.toFixed(4)})`}`;
  const end = r.endedBy === "report" ? "" : ` ended=${r.endedBy ?? "?"}`;
  const esc = r.escalated ? ` →${r.finalTier}` : "";
  const mark = r.pass ? "PASS" : r.falsePass ? "FALSE PASS" : "fail";
  return `  ${mark.padEnd(10)} ${r.task.padEnd(14)} ${r.tier.padEnd(7)} turns=${String(r.turns).padStart(3)} ${(r.wallMs / 1000).toFixed(1).padStart(6)}s ${cost}${esc}${end} — ${r.detail}`;
}

export async function runAgentSuite(argv: string[]): Promise<void> {
  const args = parseSuiteArgs(argv);
  setClientVia("agent-bench");
  console.log(
    `bx agent bench — profile=${args.profile} headless=${args.headless} tiers=${args.tiers.join(",")} ` +
      `tasks=${args.tasks.length} repeat=${args.repeat} budget=$${args.budgetUsd}/run wall=${args.maxWallMs / 1000}s/run`,
  );

  const run = await ensureDaemon(args.profile, { headless: args.headless });
  const pages = startPageServer();
  const env: Env = { profile: args.profile, fixture: `http://127.0.0.1:${run.port}/fixture`, pages };
  const runs: TaskRun[] = [];
  let capped = false;
  const spent = (): number => runs.reduce((n, r) => n + r.estUsd, 0);

  try {
    suite: for (const tier of args.tiers) {
      for (let repeat = 1; repeat <= args.repeat; repeat++) {
        for (const task of args.tasks) {
          if (args.maxTotalUsd !== undefined && spent() >= args.maxTotalUsd) {
            console.log(`stopping: est $${spent().toFixed(4)} reached --max-total $${args.maxTotalUsd}`);
            capped = true;
            break suite;
          }
          await task.setup(env);
          const report = await runAgent(
            {
              instruction: task.instruction(env),
              profile: args.profile,
              model: tier === "ladder" ? "haiku" : tier,
              startUrl: task.startUrl?.(env),
              winExpr: task.winExpr,
              budgetUsd: args.budgetUsd,
              maxWallMs: args.maxWallMs,
              heartbeatTurns: 0,
            },
            { escalate: tier === "ladder", via: "bench" },
          );
          let verdict: Verdict;
          try {
            verdict = await task.check(env, report);
          } catch (e: unknown) {
            verdict = { pass: false, detail: `check failed: ${e instanceof Error ? e.message : String(e)}` };
          }
          const r: TaskRun = {
            task: task.id,
            tier,
            repeat,
            pass: verdict.pass,
            falsePass: report.status === "pass" && !verdict.pass,
            detail: verdict.detail,
            status: report.status,
            endedBy: report.endedBy,
            finalTier: report.tier,
            escalated: report.escalated,
            turns: report.turns,
            wallMs: report.wallMs,
            estUsd: report.estUsd ?? 0,
            sdkUsd: report.usage.costUsd,
            transcript: report.transcriptPath,
          };
          runs.push(r);
          console.log(line(r));
        }
      }
    }
  } finally {
    pages.stop();
    await stopDaemon(args.profile);
  }

  const tiers: Partial<Record<Tier, TierSummary>> = {};
  for (const tier of args.tiers) tiers[tier] = summarize(runs.filter((r) => r.tier === tier));

  const results: SuiteResults = {
    date: new Date().toISOString(),
    pricesChecked: PRICES_CHECKED,
    models: MODEL_IDS,
    commit: commitSha(args.commit),
    profile: args.profile,
    headless: args.headless,
    tasks: args.tasks.map((t) => t.id),
    repeat: args.repeat,
    budgetUsd: args.budgetUsd,
    maxWallMs: args.maxWallMs,
    partial: capped || args.tasks.length < TASKS.length,
    tiers,
    runs,
  };

  console.log("");
  for (const [tier, s] of Object.entries(tiers)) {
    console.log(
      `${tier.padEnd(7)} pass ${s.passed}/${s.runs} (${Math.round(s.passRate * 100)}%)  turns median ${s.medianTurns} p90 ${s.p90Turns}  ` +
        `wall median ${(s.medianWallMs / 1000).toFixed(1)}s  $${s.totalUsd.toFixed(4)} total, $${s.usdPerRun.toFixed(4)}/run` +
        `${s.usdPerPass === null ? "" : `, $${s.usdPerPass.toFixed(4)}/pass`}` +
        `${s.sdkTotalUsd === null ? "" : ` (sdk $${s.sdkTotalUsd.toFixed(4)})`}  false passes ${s.falsePasses}`,
    );
  }

  const outPath = path.resolve(import.meta.dir, "../..", "bench-agent-results.json");
  await Bun.write(outPath, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`wrote ${outPath}`);
}
