// End-to-end smoke tests: a real daemon, real Chrome, and the bundled fixture
// app. These are ordered — the login test establishes the session every later
// test relies on — and share one daemon for the whole file.
//
//   bun test

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { cmd, ensureDaemon, stopDaemon } from "../src/client.ts";
import { runFlow } from "../src/flows/runner.ts";
import { BUDGET } from "../src/protocol.ts";
import type {
  ActionResult,
  CmdResult,
  ConsoleEntry,
  El,
  ElsResult,
  ExpectResult,
  NetEntry,
  OpenResult,
  TextResult,
} from "../src/protocol.ts";

const PROFILE = "bxtest";
const TIMEOUT = 30_000;

let fixture = "";

function ok<T>(r: CmdResult<T>, what: string): T {
  if (!r.ok) throw new Error(`${what} failed: ${r.error.code} — ${r.error.message}`);
  return r.data;
}

function mentions(el: El, needle: string): boolean {
  const n = needle.toLowerCase();
  return el.name.toLowerCase().includes(n) || (el.testid ?? "").toLowerCase().includes(n);
}

async function goto(view: "Tasks" | "Settings"): Promise<void> {
  ok(await cmd<ActionResult>(PROFILE, { cmd: "click", target: { text: view } }), `nav to ${view}`);
}

beforeAll(async () => {
  await stopDaemon(PROFILE);
  const run = await ensureDaemon(PROFILE, { headless: true });
  fixture = `http://127.0.0.1:${run.port}/fixture`;
}, 60_000);

afterAll(async () => {
  await stopDaemon(PROFILE);
}, TIMEOUT);

test(
  "daemon boots and serves fixture",
  async () => {
    const r = await cmd<OpenResult>(PROFILE, { cmd: "open", url: fixture });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error.message);

    expect(r.data.page.title).toContain("TaskBox");
    const rendered = r.data.els.rendered;
    expect(rendered.includes("sign-in") || rendered.includes("Sign in")).toBe(true);
  },
  TIMEOUT,
);

test(
  "login flow",
  async () => {
    ok(
      await cmd<ActionResult>(PROFILE, {
        cmd: "fill",
        target: { text: "email" },
        value: "demo@taskbox.test",
      }),
      "fill email",
    );
    ok(
      await cmd<ActionResult>(PROFILE, {
        cmd: "fill",
        target: { text: "password" },
        value: "hunter2",
      }),
      "fill password",
    );
    ok(await cmd<ActionResult>(PROFILE, { cmd: "click", target: { text: "sign-in" } }), "click sign-in");

    const r = await cmd<ExpectResult>(PROFILE, { cmd: "expect", kind: "url", value: "#/tasks" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.data.pass).toBe(true);
  },
  TIMEOUT,
);

test(
  "els refs are clickable",
  async () => {
    const els = ok(await cmd<ElsResult>(PROFILE, { cmd: "els" }), "els");
    const settings = els.els.find((el) => mentions(el, "settings"));
    if (!settings) throw new Error(`no Settings element in els output:\n${els.rendered}`);

    const clicked = await cmd<ActionResult>(PROFILE, { cmd: "click", target: { ref: settings.ref } });
    expect(clicked.ok).toBe(true);
    if (!clicked.ok) throw new Error(clicked.error.message);
    expect(clicked.data.navigated).toBe(true);

    const atSettings = ok(
      await cmd<ExpectResult>(PROFILE, { cmd: "expect", kind: "url", value: "#/settings" }),
      "expect url #/settings",
    );
    expect(atSettings.pass).toBe(true);
  },
  TIMEOUT,
);

test(
  "expect fail is not an error",
  async () => {
    const r = await cmd<ExpectResult>(PROFILE, {
      cmd: "expect",
      kind: "text",
      value: "This Text Does Not Exist",
      timeoutMs: 1000,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.data.pass).toBe(false);
  },
  TIMEOUT,
);

test(
  "add and delete a task",
  async () => {
    await goto("Tasks");

    ok(
      await cmd<ActionResult>(PROFILE, {
        cmd: "fill",
        target: { text: "new-task" },
        value: "smoke task",
      }),
      "fill new-task",
    );
    ok(await cmd<ActionResult>(PROFILE, { cmd: "click", target: { text: "add-task" } }), "click add-task");

    const added = await cmd<ExpectResult>(PROFILE, { cmd: "expect", kind: "text", value: "smoke task" });
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error(added.error.message);
    expect(added.data.pass).toBe(true);

    ok(
      await cmd<ActionResult>(PROFILE, { cmd: "click", target: { text: "Delete smoke task" } }),
      "click delete",
    );

    const gone = await cmd<ExpectResult>(PROFILE, {
      cmd: "expect",
      kind: "notVisible",
      value: "smoke task",
    });
    expect(gone.ok).toBe(true);
    if (!gone.ok) throw new Error(gone.error.message);
    expect(gone.data.pass).toBe(true);
  },
  TIMEOUT,
);

test(
  "console capture",
  async () => {
    // The trigger lives on whichever view the fixture puts it on; try the
    // current one, then Settings.
    let clicked = await cmd<ActionResult>(PROFILE, { cmd: "click", target: { text: "trigger-error" } });
    if (!clicked.ok && clicked.error.code === "target_not_found") {
      await goto("Settings");
      clicked = await cmd<ActionResult>(PROFILE, { cmd: "click", target: { text: "trigger-error" } });
    }
    ok(clicked, "click trigger-error");

    ok(await cmd<ActionResult>(PROFILE, { cmd: "wait", ms: 300 }), "wait 300ms");

    const entries = ok(await cmd<ConsoleEntry[]>(PROFILE, { cmd: "console", all: true }), "console");
    const hit = entries.some((e) => e.text.includes("simulated failure"));
    if (!hit) {
      throw new Error(`no console entry mentioning "simulated failure" in:\n${entries.map((e) => `${e.level}: ${e.text}`).join("\n")}`);
    }
    expect(hit).toBe(true);
  },
  TIMEOUT,
);

test(
  "network capture",
  async () => {
    const entries = ok(await cmd<NetEntry[]>(PROFILE, { cmd: "net", failed: true }), "net");
    const hit = entries.some((e) => e.url.includes("missing.json"));
    if (!hit) {
      throw new Error(`no failed request for missing.json in:\n${entries.map((e) => `${e.status} ${e.url}`).join("\n")}`);
    }
    expect(hit).toBe(true);
  },
  TIMEOUT,
);

test(
  "stale ref rejected",
  async () => {
    await goto("Settings");
    const els = ok(await cmd<ElsResult>(PROFILE, { cmd: "els" }), "els");
    const target = els.els.find((el) => mentions(el, "dark-mode")) ?? els.els[0];
    if (!target) throw new Error("els returned no elements on the Settings view");
    const staleRef = target.ref;

    await goto("Tasks");

    const r = await cmd<ActionResult>(PROFILE, { cmd: "click", target: { ref: staleRef } });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error(`ref ${staleRef} was still accepted after navigating away`);

    // Either code is acceptable; log which one the daemon actually produces.
    const acceptable = ["stale_ref", "target_not_found"];
    if (!acceptable.includes(r.error.code)) {
      throw new Error(`stale ref produced ${r.error.code} (${r.error.message}); expected stale_ref or target_not_found`);
    }
    console.log(`stale ref → error code "${r.error.code}"`);
    expect(acceptable).toContain(r.error.code);
  },
  TIMEOUT,
);

test(
  "text budget respected",
  async () => {
    const r = await cmd<TextResult>(PROFILE, { cmd: "text" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.data.text.length).toBeLessThanOrEqual(BUDGET.TEXT_MAX_CHARS);
  },
  TIMEOUT,
);

test(
  "runner executes a flow file",
  async () => {
    const dir = path.join(os.tmpdir(), `bx-smoke-${Math.random().toString(36).slice(2, 10)}`);
    const file = path.join(dir, "login.flow.ts");
    const apiUrl = pathToFileURL(path.resolve(import.meta.dir, "../src/flows/api.ts")).href;

    fs.mkdirSync(dir, { recursive: true });
    try {
      await Bun.write(
        file,
        `import { flow } from "${apiUrl}";

export const smokeNav = flow("smoke-nav", async (c) => {
  await c.open("${fixture}");
  await c.click("Tasks");
  await c.expectUrl("#/tasks");
});

export default smokeNav;
`,
      );

      const passed = await runFlow(file, { profile: PROFILE, record: false });
      expect(passed).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);
