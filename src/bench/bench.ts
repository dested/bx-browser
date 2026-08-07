// bx benchmark harness.
//
//   bun src/bench/bench.ts [--profile bxbench] [--headed] [--agent]
//
// Measures the numbers that justify bx over a screenshot-loop extension: cold
// start, per-verb latency, the token cost of an observation, and deterministic
// flow replay. The agent section spends real subscription tokens, so it only
// runs behind --agent. Results land in bench-results.json at the repo root.

import * as os from "node:os";
import * as path from "node:path";

import { cmd, ensureDaemon, stopDaemon } from "../client.ts";
import { FlowContext } from "../flows/api.ts";
import type {
  ActionResult,
  AgentReport,
  AgentUsage,
  CmdResult,
  ElsResult,
  ExpectResult,
  JsResult,
  OpenResult,
  SnapResult,
  TextResult,
} from "../protocol.ts";

// ---------------------------------------------------------------------------
// Result shape written to bench-results.json
// ---------------------------------------------------------------------------

interface VerbStat {
  median: number;
  p95: number;
}

interface AgentSection {
  status: AgentReport["status"];
  tier: AgentReport["tier"];
  escalated: boolean;
  turns: number;
  wallMs: number;
  usage: AgentUsage;
}

interface BenchResults {
  date: string;
  machine: { platform: string; cpus: number; bun: string };
  coldStartMs: number;
  verbs: {
    els: VerbStat;
    click: VerbStat;
    fill: VerbStat;
    snap: VerbStat;
    text: VerbStat;
    js: VerbStat;
  };
  observation: {
    els: { chars: number; estTokens: number; elements: number };
    text: { chars: number; estTokens: number };
    rawDomChars: number;
    rawDomEstTokens: number;
    snap: { bytes: number; width: number; height: number; estImageTokens: number };
  };
  flowReplay: { medianMs: number; steps: number };
  agent: AgentSection | null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

function argValue(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

const profile = argValue("profile") ?? "bxbench";
const headless = !argv.includes("--headed");
const withAgent = argv.includes("--agent");

const EMAIL = "demo@taskbox.test";
const PASSWORD = "hunter2";
const CHARS_PER_TOKEN = 4;
const PIXELS_PER_IMAGE_TOKEN = 750;

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function estTokens(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN);
}

function at(samples: number[], i: number): number {
  const v = samples[i];
  if (v === undefined) throw new Error(`sample index ${i} out of range (n=${samples.length})`);
  return v;
}

function stat(samples: number[]): VerbStat {
  if (samples.length === 0) throw new Error("no samples collected");
  const s = [...samples].sort((a, b) => a - b);
  const mid = s.length >> 1;
  const median = s.length % 2 === 1 ? at(s, mid) : (at(s, mid - 1) + at(s, mid)) / 2;
  const p95 = at(s, Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1));
  return { median: round(median), p95: round(p95) };
}

async function timed<T>(fn: () => Promise<T>): Promise<[number, T]> {
  const t = performance.now();
  const value = await fn();
  return [performance.now() - t, value];
}

function unwrap<T>(r: CmdResult<T>, what: string): T {
  if (!r.ok) throw new Error(`${what} failed: ${r.error.code} — ${r.error.message}`);
  return r.data;
}

async function sample<T>(n: number, what: string, fn: (i: number) => Promise<CmdResult<T>>): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const [ms, r] = await timed(() => fn(i));
    unwrap(r, `${what} #${i}`);
    out.push(ms);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bench
// ---------------------------------------------------------------------------

async function login(): Promise<void> {
  unwrap(
    await cmd<ActionResult>(profile, { cmd: "fill", target: { text: "email" }, value: EMAIL }),
    "fill email",
  );
  unwrap(
    await cmd<ActionResult>(profile, { cmd: "fill", target: { text: "password" }, value: PASSWORD }),
    "fill password",
  );
  unwrap(await cmd<ActionResult>(profile, { cmd: "click", target: { text: "sign-in" } }), "click sign-in");
  const signedIn = unwrap(
    await cmd<ExpectResult>(profile, { cmd: "expect", kind: "url", value: "#/tasks" }),
    "expect url #/tasks",
  );
  if (!signedIn.pass) {
    throw new Error(`fixture login did not reach #/tasks — bench cannot continue. ${signedIn.detail}`);
  }
}

async function measureVerbs(): Promise<BenchResults["verbs"]> {
  const els = await sample(10, "els", () => cmd<ElsResult>(profile, { cmd: "els" }));

  // Nav links are clicked deliberately: a bx click includes the navigation and
  // the post-navigation settle, which is the latency a caller actually pays.
  const click = await sample(10, "click", (i) =>
    cmd<ActionResult>(profile, { cmd: "click", target: { text: i % 2 === 0 ? "Settings" : "Tasks" } }),
  );

  const fill = await sample(10, "fill", (i) =>
    cmd<ActionResult>(profile, { cmd: "fill", target: { text: "new-task" }, value: `bench item ${i}` }),
  );

  const snap = await sample(5, "snap", () => cmd<SnapResult>(profile, { cmd: "snap" }));
  const text = await sample(5, "text", () => cmd<TextResult>(profile, { cmd: "text" }));
  const js = await sample(10, "js", () => cmd<JsResult>(profile, { cmd: "js", expression: "1+1" }));

  return {
    els: stat(els),
    click: stat(click),
    fill: stat(fill),
    snap: stat(snap),
    text: stat(text),
    js: stat(js),
  };
}

async function measureObservation(): Promise<BenchResults["observation"]> {
  unwrap(await cmd<ActionResult>(profile, { cmd: "click", target: { text: "Tasks" } }), "nav to Tasks");

  const elsR = unwrap(await cmd<ElsResult>(profile, { cmd: "els" }), "els");
  const textR = unwrap(await cmd<TextResult>(profile, { cmd: "text" }), "text");
  const domR = unwrap(
    await cmd<JsResult>(profile, {
      cmd: "js",
      expression: "document.documentElement.outerHTML.length",
    }),
    "js outerHTML.length",
  );
  const snapR = unwrap(await cmd<SnapResult>(profile, { cmd: "snap" }), "snap");

  const rawDomChars = Number(domR.value);
  if (!Number.isFinite(rawDomChars)) {
    throw new Error(`expected a number from outerHTML.length, got ${JSON.stringify(domR.value)}`);
  }

  return {
    els: {
      chars: elsR.rendered.length,
      estTokens: estTokens(elsR.rendered.length),
      elements: elsR.els.length,
    },
    text: { chars: textR.text.length, estTokens: estTokens(textR.text.length) },
    rawDomChars,
    rawDomEstTokens: estTokens(rawDomChars),
    snap: {
      bytes: snapR.bytes,
      width: snapR.width,
      height: snapR.height,
      estImageTokens: Math.round((snapR.width * snapR.height) / PIXELS_PER_IMAGE_TOKEN),
    },
  };
}

async function measureFlowReplay(fixtureBase: string): Promise<BenchResults["flowReplay"]> {
  const steps = async (c: FlowContext): Promise<void> => {
    await c.open(fixtureBase);
    await c.click("Settings");
    await c.click("dark-mode");
    await c.expectText("Dark mode on");
    await c.click("dark-mode");
    await c.click("Tasks");
    await c.fill("new-task", "replay task");
    await c.click("add-task");
    await c.expectText("replay task");
  };

  const durations: number[] = [];
  let stepCount = 0;
  for (let i = 0; i < 3; i++) {
    let seen = 0;
    const ctx = new FlowContext(profile, {
      onStep: () => {
        seen++;
      },
    });
    const [ms] = await timed(() => steps(ctx));
    durations.push(ms);
    stepCount = seen;
  }

  if (stepCount === 0) {
    console.warn("warning: FlowContext emitted no onStep events; step count reported as 0");
  }
  return { medianMs: stat(durations).median, steps: stepCount };
}

async function measureAgent(fixtureBase: string): Promise<AgentSection> {
  const { runAgent } = await import("../agent/driver.ts");
  const report = await runAgent({
    instruction: `Open ${fixtureBase} then go to Settings, turn on dark mode, and verify the page says "Dark mode on".`,
    profile,
    model: "haiku",
  });
  return {
    status: report.status,
    tier: report.tier,
    escalated: report.escalated,
    turns: report.turns,
    wallMs: round(report.wallMs),
    usage: report.usage,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function row(label: string, value: string, extra = ""): string {
  return `  ${label.padEnd(24)}${value.padStart(12)}  ${extra}`;
}

function printReport(r: BenchResults): void {
  const lines: string[] = [];
  lines.push("");
  lines.push(`bx bench — ${r.date}`);
  lines.push(`  ${r.machine.platform}, ${r.machine.cpus} cpus, bun ${r.machine.bun}`);
  lines.push("");
  lines.push("cold start");
  lines.push(row("daemon + chrome + open", `${r.coldStartMs} ms`));
  lines.push("");
  lines.push(`verb latency${" ".repeat(12)}${"median".padStart(12)}${"p95".padStart(12)}`);
  for (const [name, s] of Object.entries(r.verbs)) {
    lines.push(`  ${name.padEnd(22)}${`${s.median} ms`.padStart(12)}${`${s.p95} ms`.padStart(12)}`);
  }
  lines.push("");
  lines.push("observation economics (tasks view)");
  lines.push(row("els", `${r.observation.els.chars} ch`, `~${r.observation.els.estTokens} tok, ${r.observation.els.elements} els`));
  lines.push(row("text", `${r.observation.text.chars} ch`, `~${r.observation.text.estTokens} tok`));
  lines.push(row("raw dom (naive dump)", `${r.observation.rawDomChars} ch`, `~${r.observation.rawDomEstTokens} tok`));
  lines.push(
    row("snap", `${r.observation.snap.bytes} B`, `${r.observation.snap.width}x${r.observation.snap.height}, ~${r.observation.snap.estImageTokens} img tok`),
  );
  const ratio = r.observation.els.estTokens > 0 ? Math.round(r.observation.rawDomEstTokens / r.observation.els.estTokens) : 0;
  lines.push(row("els vs raw dom", `${ratio}x`, "cheaper"));
  lines.push("");
  lines.push("flow replay (0 model tokens)");
  lines.push(row("median wall", `${r.flowReplay.medianMs} ms`, `${r.flowReplay.steps} steps`));
  lines.push("");
  if (r.agent) {
    lines.push("agent (subscription tokens)");
    lines.push(row("status", r.agent.status, `${r.agent.tier}${r.agent.escalated ? " (escalated)" : ""}`));
    lines.push(row("turns", String(r.agent.turns), `${r.agent.wallMs} ms`));
    lines.push(
      row("tokens", String(r.agent.usage.inputTokens + r.agent.usage.outputTokens), `in ${r.agent.usage.inputTokens} / out ${r.agent.usage.outputTokens} / cache ${r.agent.usage.cacheReadTokens}`),
    );
    if (r.agent.usage.costUsd !== null) lines.push(row("cost", `$${r.agent.usage.costUsd.toFixed(4)}`));
  } else {
    lines.push("agent                     skipped (pass --agent to measure)");
  }
  lines.push("");
  console.log(lines.join("\n"));
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`bx bench — profile=${profile} headless=${headless} agent=${withAgent}`);

  // Guaranteed cold start: no daemon, no browser, nothing warm.
  await stopDaemon(profile);

  const t0 = performance.now();
  const run = await ensureDaemon(profile, { headless });
  const fixtureBase = `http://127.0.0.1:${run.port}/fixture`;
  unwrap(await cmd<OpenResult>(profile, { cmd: "open", url: fixtureBase }), "open fixture");
  const coldStartMs = round(performance.now() - t0);
  console.log(`cold start: ${coldStartMs} ms (${fixtureBase})`);

  try {
    await login();
    console.log("logged in to fixture");

    const verbs = await measureVerbs();
    console.log("verb latency sampled");

    const observation = await measureObservation();
    console.log("observation economics sampled");

    const flowReplay = await measureFlowReplay(fixtureBase);
    console.log("flow replay sampled");

    const agent = withAgent ? await measureAgent(fixtureBase) : null;
    if (agent) console.log(`agent run: ${agent.status} (${agent.tier})`);

    const results: BenchResults = {
      date: new Date().toISOString(),
      machine: { platform: process.platform, cpus: os.cpus().length, bun: Bun.version },
      coldStartMs,
      verbs,
      observation,
      flowReplay,
      agent,
    };

    const outPath = path.resolve(import.meta.dir, "../..", "bench-results.json");
    await Bun.write(outPath, `${JSON.stringify(results, null, 2)}\n`);
    printReport(results);
    console.log(`wrote ${outPath}`);
  } finally {
    await stopDaemon(profile);
  }
}

main().catch((err: unknown) => {
  console.error(`bench failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
