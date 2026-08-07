// Turns a daemon action log into a replayable flow file. Refs never survive a
// session, so every target comes from the entry's replay-stable form.

import { CmdSchema } from "../protocol.ts";
import type { ActionLogEntry, Target } from "../protocol.ts";

const REDACTED_MARK = "•••";

function q(s: string): string {
  return JSON.stringify(s);
}

function textOf(target: Target): string {
  if ("text" in target) return target.text;
  if ("selector" in target) return target.selector;
  return String(target.ref);
}

function stable(entry: ActionLogEntry, target: Target): string {
  return entry.stableTarget ?? textOf(target);
}

function linesFor(entry: ActionLogEntry): string[] {
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
        return [
          "// TODO: value redacted at record time — this was a password field",
          `await b.fill(${q(stable(entry, c.target))}, "");`,
        ];
      }
      return [`await b.fill(${q(stable(entry, c.target))}, ${q(c.value)});`];
    case "press":
      return [`await b.press(${q(c.key)});`];
    case "select":
      return [`await b.select(${q(stable(entry, c.target))}, ${q(c.value)});`];
    case "back":
      return ["await b.back();"];
    case "reload":
      return ["await b.reload();"];
    case "tabNew":
    case "tabSelect":
    case "tabClose":
      return ["// (tab change omitted)"];
    default:
      return [];
  }
}

export function synthesizeFlow(entries: ActionLogEntry[], name: string): string {
  const body = entries.flatMap(linesFor).map((line) => `  ${line}`);
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
