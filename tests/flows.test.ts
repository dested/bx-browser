// Flow synthesis and the "bx/flow" import alias. No daemon, no browser —
// these are pure unit tests plus one module-resolution check.
//
//   bun test tests/flows.test.ts

import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { aliasFlowImport, failureBase } from "../src/flows/runner.ts";
import { passwordEnvVar, synthesizeFlow } from "../src/flows/synthesize.ts";
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

test("synthesizeFlow emits drive with its controller, predicate and options", () => {
  const src = synthesizeFlow([
    entry(
      {
        cmd: "drive",
        install: "window.__ctl = () => ({ thrust: 1 });",
        until: "window.__game.score > 100",
        timeoutMs: 5000,
      },
      "drove until window.__game.score > 100",
    ),
  ], "drive the game");

  expect(src).toContain("  await b.drive(");
  expect(src).toContain(JSON.stringify("window.__ctl = () => ({ thrust: 1 });"));
  expect(src).toContain(JSON.stringify("window.__game.score > 100"));
  expect(src).toContain("timeoutMs: 5000");
  expect(src).not.toContain("pollMs");
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

test("synthesizeFlow replays password fills from BX_<FLOW>_PASSWORD", () => {
  const src = synthesizeFlow([
    entry({ cmd: "fill", target: { text: "Password" }, value: "•••" }, 'filled "Password" with "•••"', "Password"),
  ], "log in: demo");
  expect(passwordEnvVar("log in: demo")).toBe("BX_LOG_IN_DEMO_PASSWORD");
  expect(src).toContain(`  await b.fill("Password", process.env.BX_LOG_IN_DEMO_PASSWORD ?? "");`);
  expect(src).toContain("TODO");
  expect(src).not.toContain("•••");
});

test("synthesizeFlow replays js steps and keeps target prefixes", () => {
  const src = synthesizeFlow([
    entry({ cmd: "js", expression: "localStorage.setItem('k', '1')" }, "ran js"),
    entry({ cmd: "click", target: { role: "button", name: "Save" } }, 'clicked "Save"'),
    entry({ cmd: "click", target: { testid: "add-task" } }, 'clicked "add-task"'),
    entry({ cmd: "fill", target: { label: "Email" }, value: "a@b.c" }, 'filled "Email"'),
  ], "js and prefixes");
  expect(src).toContain(`  await b.js(${JSON.stringify("localStorage.setItem('k', '1')")});`);
  expect(src).toContain(`  await b.click("role:button:Save");`);
  expect(src).toContain(`  await b.click("testid:add-task");`);
  expect(src).toContain(`  await b.fill("label:Email", "a@b.c");`);
});

test("failureBase puts fail artifacts beside the flow file", () => {
  const dir = path.join(os.tmpdir(), "flows");
  expect(failureBase(path.join(dir, "login.flow.ts"))).toBe(path.join(dir, "login"));
  expect(failureBase(path.join(dir, "checkout.ts"))).toBe(path.join(dir, "checkout"));
});

test("synthesizeFlow collapses a js poll repeated back to back", () => {
  const poll = entry({ cmd: "js", expression: "window.__game.won" }, "ran js");
  const src = synthesizeFlow([poll, { ...poll, index: 99 }, { ...poll, index: 100 }], "poll");
  expect(src.split("\n").filter((l) => l.includes("b.js(")).length).toBe(1);
});
