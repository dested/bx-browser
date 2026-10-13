// Turns a daemon action log into a replayable flow file. Refs never survive a
// session, so every target comes from the entry's replay-stable form.

import { CmdSchema } from "../protocol.ts";
import type { ActionLogEntry, Target } from "../protocol.ts";

const REDACTED_MARK = "•••";

const EXPECT_VERB = {
  text: "expectText",
  url: "expectUrl",
  visible: "expectVisible",
  notVisible: "expectNotVisible",
} as const;

function q(s: string): string {
  return JSON.stringify(s);
}

/** The target in the string form parseTarget reads back (prefixes kept). */
function textOf(target: Target): string {
  if ("text" in target) return target.text;
  if ("selector" in target) return target.selector;
  if ("testid" in target) return `testid:${target.testid}`;
  if ("label" in target) return `label:${target.label}`;
  if ("role" in target) return target.name === undefined ? `role:${target.role}` : `role:${target.role}:${target.name}`;
  return String(target.ref);
}

/** `BX_<FLOW>_PASSWORD`: the env var a recorded password fill replays from. */
export function passwordEnvVar(flowName: string): string {
  const slug = flowName.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `BX_${slug === "" ? "FLOW" : slug}_PASSWORD`;
}

function stable(entry: ActionLogEntry, target: Target): string {
  return entry.stableTarget ?? textOf(target);
}

/** Trailing options object for the coordinate verbs, omitted when empty. */
function options(parts: string[]): string {
  return parts.length === 0 ? "" : `, { ${parts.join(", ")} }`;
}

function linesFor(entry: ActionLogEntry, flowName: string): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(entry.cmdJson);
  } catch {
    return [`// (unreadable action: ${entry.text})`];
  }
  const parsed = CmdSchema.safeParse(raw);
  if (!parsed.success) return [`// (unsupported action: ${entry.text})`];
  const c = parsed.data;

  switch (c.cmd) {
    case "open":
      return [`await b.open(${q(c.url)});`];
    case "click":
      return [`await b.click(${q(stable(entry, c.target))});`];
    case "fill":
      if (entry.text.includes(REDACTED_MARK)) {
        const envVar = passwordEnvVar(flowName);
        return [
          `// TODO: value redacted at record time (a password field) — set ${envVar} to replay it`,
          `await b.fill(${q(stable(entry, c.target))}, process.env.${envVar} ?? "");`,
        ];
      }
      return [`await b.fill(${q(stable(entry, c.target))}, ${q(c.value)});`];
    case "press":
      return [`await b.press(${q(c.key)});`];
    case "select":
      return [`await b.select(${q(stable(entry, c.target))}, ${q(c.value)});`];
    case "expect":
      return [`await b.${EXPECT_VERB[c.kind]}(${q(c.value)});`];
    case "mouse": {
      const opts = [
        ...(c.in ? [`in: ${q(stable(entry, c.in))}`] : []),
        ...(c.button ? [`button: ${q(c.button)}`] : []),
      ];
      return [`await b.mouse(${q(c.action)}, ${c.x}, ${c.y}${options(opts)});`];
    }
    case "drag": {
      const opts = [
        ...(c.in ? [`in: ${q(stable(entry, c.in))}`] : []),
        ...(c.steps === undefined ? [] : [`steps: ${c.steps}`]),
        ...(c.mode === undefined ? [] : [`mode: ${q(c.mode)}`]),
        ...(c.holdMs === undefined ? [] : [`holdMs: ${c.holdMs}`]),
        ...(c.stepDelayMs === undefined ? [] : [`stepDelayMs: ${c.stepDelayMs}`]),
      ];
      return [`await b.drag(${c.fromX}, ${c.fromY}, ${c.toX}, ${c.toY}${options(opts)});`];
    }
    case "drive": {
      const opts = [
        ...(c.timeoutMs === undefined ? [] : [`timeoutMs: ${c.timeoutMs}`]),
        ...(c.pollMs === undefined ? [] : [`pollMs: ${c.pollMs}`]),
      ];
      return [`await b.drive(${q(c.install)}, ${q(c.until)}${options(opts)});`];
    }
    case "key":
      return [`await b.${c.action === "down" ? "keyDown" : "keyUp"}(${q(c.key)});`];
    case "wheel": {
      const opts = [
        ...(c.x === undefined ? [] : [`x: ${c.x}`]),
        ...(c.y === undefined ? [] : [`y: ${c.y}`]),
        ...(c.in ? [`in: ${q(stable(entry, c.in))}`] : []),
      ];
      return [`await b.wheel(${c.deltaY}${options(opts)});`];
    }
    // Any js in the log replays: it may have changed state the later steps need.
    case "js":
      return [`await b.js(${q(c.expression)});`];
    case "back":
      return ["await b.back();"];
    case "reload":
      return ["await b.reload();"];
    default:
      return [];
  }
}

// Only opens participate in de-duplication, so the url is all synthesizeFlow
// needs to know about an entry beyond its lines.
function openUrlOf(entry: ActionLogEntry): string | null {
  if (entry.cmd !== "open") return null;
  try {
    const parsed = CmdSchema.safeParse(JSON.parse(entry.cmdJson));
    return parsed.success && parsed.data.cmd === "open" ? parsed.data.url : null;
  } catch {
    return null;
  }
}

export function synthesizeFlow(entries: ActionLogEntry[], name: string): string {
  const body: string[] = [];
  // An agent run re-opens the same url whenever it re-orients; back-to-back
  // opens of one url are noise. A later re-open with anything emitted in
  // between is a real navigation and survives.
  let lastOpenUrl: string | null = null;
  // Likewise a js poll repeated back to back (an agent checking its win
  // predicate) replays once.
  let lastJs: string | null = null;
  for (const entry of entries) {
    const url = openUrlOf(entry);
    if (url !== null && url === lastOpenUrl) continue;
    const lines = linesFor(entry, name);
    if (lines.length === 0) continue;
    const js = entry.cmd === "js" ? lines.join("\n") : null;
    if (js !== null && js === lastJs) continue;
    lastOpenUrl = url;
    lastJs = js;
    for (const line of lines) body.push(`  ${line}`);
  }
  return [
    `// synthesized by bx agent — ${new Date().toISOString()}`,
    `import { flow } from "bx/flow";`,
    "",
    `export default flow(${q(name)}, async (b) => {`,
    ...body,
    "});",
    "",
  ].join("\n");
}
