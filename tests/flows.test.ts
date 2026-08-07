// Flow synthesis and the "bx/flow" import alias. No daemon, no browser —
// these are pure unit tests plus one module-resolution check.
//
//   bun test tests/flows.test.ts

import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { aliasFlowImport } from "../src/flows/runner.ts";
import { synthesizeFlow } from "../src/flows/synthesize.ts";
import type { ActionLogEntry, Cmd } from "../src/protocol.ts";

const FIXTURE_URL = "http://127.0.0.1:9999/fixture";

let index = 0;
function entry(c: Cmd, text: string, stableTarget?: string): ActionLogEntry {
  index++;
  return { index, t: index * 10, cmd: c.cmd, text, cmdJson: JSON.stringify(c), stableTarget };
}

const tmpFiles: string[] = [];
afterAll(() => {
  for (const file of tmpFiles) fs.rmSync(file, { force: true });
});

test("synthesizeFlow emits assertions, drops tab churn and duplicate opens", () => {
  const src = synthesizeFlow([
    entry({ cmd: "tabNew" }, "opened a new tab"),
    entry({ cmd: "open", url: FIXTURE_URL }, `opened ${FIXTURE_URL}`),
    entry({ cmd: "open", url: FIXTURE_URL }, `opened ${FIXTURE_URL}`),
    entry({ cmd: "click", target: { text: "Add task" } }, 'clicked "Add task"', "add-task"),
    entry({ cmd: "expect", kind: "text", value: "Saved" }, 'expect text "Saved" passed'),
    entry({ cmd: "expect", kind: "url", value: "#/tasks" }, 'expect url "#/tasks" passed'),
    entry({ cmd: "open", url: FIXTURE_URL }, `opened ${FIXTURE_URL}`),
  ], "add a task");

  process.stdout.write(`\n${src}\n`);

  const lines = src.split("\n");
  expect(lines[1]).toBe(`import { flow } from "bx/flow";`);
  expect(src).toContain(`export default flow("add a task", async (b) => {`);
  expect(src).toContain(`  await b.expectText("Saved");`);
  expect(src).toContain(`  await b.expectUrl("#/tasks");`);
  expect(src).toContain(`  await b.click("add-task");`);
  expect(src).not.toContain("tab change omitted");

  // Two consecutive opens collapse to one; the later re-open, with a click and
  // two expects between, survives.
  const opens = lines.filter((line) => line.includes("await b.open("));
  expect(opens).toEqual([`  await b.open(${JSON.stringify(FIXTURE_URL)});`, `  await b.open(${JSON.stringify(FIXTURE_URL)});`]);
  expect(lines.indexOf(opens[0] ?? "")).toBeLessThan(lines.findIndex((l) => l.includes("b.click(")));
  expect(lines.lastIndexOf(opens[1] ?? "")).toBeGreaterThan(
    lines.findIndex((l) => l.includes("b.expectUrl(")),
  );
});

test("synthesizeFlow maps every expect kind", () => {
  const src = synthesizeFlow([
    entry({ cmd: "expect", kind: "visible", value: "Save" }, 'expect visible "Save" passed'),
    entry({ cmd: "expect", kind: "notVisible", value: "Spinner" }, 'expect notVisible passed'),
  ], "assertions");
  expect(src).toContain(`  await b.expectVisible("Save");`);
  expect(src).toContain(`  await b.expectNotVisible("Spinner");`);
});

test(`"bx/flow" resolves from a flow file outside the repo`, async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bx-flow-")), "x.flow.ts");
  tmpFiles.push(file);
  fs.writeFileSync(
    file,
    [
      `import { flow } from "bx/flow";`,
      ``,
      `export default flow("outside", async (b) => {`,
      `  await b.open("about:blank");`,
      `});`,
      ``,
    ].join("\n"),
  );

  // What runFlow does before importing — runFlow itself needs a live daemon.
  aliasFlowImport(file);
  const mod: unknown = await import(pathToFileURL(file).href);
  const def = typeof mod === "object" && mod !== null ? Reflect.get(mod, "default") : undefined;
  expect(typeof def === "object" && def !== null).toBe(true);
  expect(Reflect.get(Object(def), "name")).toBe("outside");
  expect(typeof Reflect.get(Object(def), "fn")).toBe("function");
});
