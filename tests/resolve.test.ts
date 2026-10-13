// Target resolution and els (resolve.ts + distill.ts) against a real headless
// Chrome, no daemon.
//
//   bun test tests/resolve.test.ts
//
// Playwright's client can't drive Chrome from Bun on Windows (no pipe fds
// 3/4, and its ws client never completes a CDP handshake), which is why the
// daemon runs on Node. So this file runs twice: under `bun test` it spawns
// `node` on itself, and under Node it launches Chrome the way the daemon does
// (persistent profile "resolver-test", OS-password check seeded first), runs
// every scenario and prints one RESULT line each. Bun turns each line into a
// test. Each scenario gets a fresh tab, so its ref counter starts at 1.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Page } from "playwright-core";

import { BX_DIR_NAME, PROFILES_DIR } from "../src/constants.ts";
import { seedOsPasswordCheck } from "../src/daemon/osPassword.ts";
import { ResolveError, resolveTarget, scanEls } from "../src/daemon/resolve.ts";
import type { El, Target } from "../src/protocol.ts";

const PROFILE_DIR = path.join(os.homedir(), BX_DIR_NAME, PROFILES_DIR, "resolver-test");
const RESULT = "RESULT ";

interface Outcome {
  name: string;
  ok: boolean;
  error?: string;
  info?: string;
}

type Scenario = (newPage: (html: string) => Promise<Page>) => Promise<string | void>;

// ---------------------------------------------------------------------------
// Helpers (Node side)
// ---------------------------------------------------------------------------

/** Click what the target resolves to; return the page's `window.hit`. */
async function clickHit(page: Page, target: Target): Promise<string> {
  const { locator } = await resolveTarget(page, target, { timeoutMs: 500 });
  await locator.click({ timeout: 2000 });
  const hit = await page.evaluate(() => String(Reflect.get(window, "hit")));
  await page.evaluate(() => Reflect.set(window, "hit", ""));
  return hit;
}

async function failure(page: Page, target: Target): Promise<ResolveError> {
  try {
    await resolveTarget(page, target, { timeoutMs: 300 });
  } catch (err) {
    if (err instanceof ResolveError) return err;
    throw err;
  }
  throw new Error(`expected ${JSON.stringify(target)} to fail`);
}

function byName(els: El[], name: string): El {
  const el = els.find((e) => e.name === name);
  if (!el) throw new Error(`no el named "${name}" in [${els.map((e) => e.name).join(", ")}]`);
  return el;
}

const HIT = (name: string): string => `onclick="window.hit='${name}'"`;

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const SCENARIOS: Record<string, Scenario> = {
  "C1: Save beats Save draft, by text and by ref": async (newPage) => {
    const page = await newPage(`<button ${HIT("draft")}>Save draft</button><button ${HIT("save")}>Save</button>`);
    assert.equal(await clickHit(page, { text: "Save" }), "save");
    const { els } = await scanEls(page);
    assert.equal(await clickHit(page, { ref: byName(els, "Save").ref }), "save");
    assert.equal(await clickHit(page, { ref: byName(els, "Save draft").ref }), "draft");
  },

  "C1: a tie is ambiguous with the tied refs; first takes the first": async (newPage) => {
    const page = await newPage(`<button ${HIT("a")}>Delete</button><p>x</p><button ${HIT("b")}>Delete</button>`);
    const err = await failure(page, { text: "Delete" });
    assert.equal(err.code, "ambiguous");
    assert.deepEqual(err.nearMatches?.map((e) => e.name), ["Delete", "Delete"]);
    const wire: unknown = JSON.parse(JSON.stringify(err));
    assert.deepEqual(Object.keys(wire ?? {}).sort(), ["code", "message", "nearMatches"]);
    assert.match(err.message, /matches 2 elements/);
    assert.equal(await clickHit(page, { text: "Delete", first: true }), "a");
    const second = err.nearMatches?.[1];
    assert.ok(second);
    assert.equal(await clickHit(page, { ref: second.ref }), "b");
  },

  "C1: exact beats prefix even off screen; viewport breaks a tie; exact drops prefixes": async (newPage) => {
    const page = await newPage(
      `<button ${HIT("long")}>Submit order</button><div style="height:3000px"></div><button ${HIT("far")}>Submit</button>`,
    );
    assert.equal(await clickHit(page, { text: "Submit" }), "far");
    assert.equal((await failure(page, { text: "Submit ord", exact: true })).code, "target_not_found");
    assert.equal(await clickHit(page, { text: "Submit ord" }), "long");
    const two = await newPage(`<button ${HIT("near")}>Next</button><div style="height:3000px"></div><button ${HIT("far")}>Next</button>`);
    assert.equal(await clickHit(two, { text: "Next" }), "near");
  },

  "C1/C7: bare digits resolve as text when the ref isn't live": async (newPage) => {
    const page = await newPage(`<a href="#1" ${HIT("1")}>1</a> <a href="#2" ${HIT("2")}>2</a> <a href="#3" ${HIT("3")}>3</a>`);
    assert.equal(await clickHit(page, { ref: 2, orText: "2" }), "2");
  },

  "C1: role, label and testid targets": async (newPage) => {
    const page = await newPage(`
      <label for="e">Email</label><input id="e" ${HIT("email")}>
      <button data-testid="go-btn" ${HIT("go")}>Go</button>
      <a href="#" ${HIT("link")}>Go</a>`);
    assert.equal(await clickHit(page, { label: "Email" }), "email");
    assert.equal(await clickHit(page, { testid: "go-btn" }), "go");
    assert.equal(await clickHit(page, { role: "link", name: "Go" }), "link");
    assert.equal((await failure(page, { text: "Go" })).code, "ambiguous");

    // a test id names non-interactive elements too (the fixture's game canvas)
    const canvas = await newPage(`<canvas id="game" data-testid="game-canvas" width="200" height="100"></canvas>`);
    const { locator, stable } = await resolveTarget(canvas, { text: "game-canvas" }, { timeoutMs: 300 });
    assert.equal(stable, "game-canvas");
    assert.equal(await locator.evaluate((e) => e.id), "game");
  },

  "C1: not found returns near matches as refs": async (newPage) => {
    const page = await newPage(`<button ${HIT("save")}>Save changes</button><button>Cancel</button>`);
    const err = await failure(page, { text: "save everything" });
    assert.equal(err.code, "target_not_found");
    assert.deepEqual(err.nearMatches?.map((e) => e.name), ["Save changes"]);
    const near = err.nearMatches?.[0];
    assert.ok(near);
    assert.equal(await clickHit(page, { ref: near.ref }), "save");
  },

  "C1: an element that appears late is found within the poll window": async (newPage) => {
    const page = await newPage(`<div id="slot"></div>`);
    await page.evaluate(() => {
      setTimeout(() => {
        const b = document.createElement("button");
        b.textContent = "Late";
        b.onclick = () => Reflect.set(window, "hit", "late");
        document.getElementById("slot")?.append(b);
      }, 300);
    });
    const { locator } = await resolveTarget(page, { text: "Late" }, { timeoutMs: 2000 });
    await locator.click();
    assert.equal(await page.evaluate(() => String(Reflect.get(window, "hit"))), "late");
  },

  "C2: a hidden test-id twin never wins": async (newPage) => {
    const page = await newPage(
      `<button data-testid="apply" style="display:none" ${HIT("hidden")}>Apply</button>
       <button data-testid="apply" ${HIT("visible")}>Apply</button>`,
    );
    assert.equal(await clickHit(page, { text: "apply" }), "visible");
    assert.equal(await clickHit(page, { testid: "apply" }), "visible");
  },

  "C2: inert, aria-hidden and transparent elements are out of els and resolution": async (newPage) => {
    const page = await newPage(
      `<div inert><button>Inert</button></div><div aria-hidden="true"><button>Muted</button></div>
       <button style="opacity:0">Ghost</button><button>Live</button>`,
    );
    const { els } = await scanEls(page);
    assert.deepEqual(els.map((e) => e.name), ["Live"]);
    assert.equal((await failure(page, { text: "Muted" })).code, "target_not_found");

    // MUI-style checkbox: a transparent native input over the visual box stays listed
    const mui = await newPage(
      `<label><span style="position:relative;display:inline-block;width:20px;height:20px">
         <input type="checkbox" style="position:absolute;inset:0;opacity:0;margin:0" ${HIT("remember")}></span>Remember me</label>`,
    );
    const listed = (await scanEls(mui)).els;
    assert.deepEqual(listed.map((e) => `${e.role}:${e.name}`), ["checkbox:Remember me"]);
    assert.equal(await clickHit(mui, { text: "Remember me" }), "remember");
  },

  "C3: refs survive re-scans and go stale only when their element leaves": async (newPage) => {
    const page = await newPage(`<button id="a" ${HIT("alpha")}>Alpha</button><button id="b">Beta</button>`);
    const first = await scanEls(page);
    const again = await scanEls(page);
    assert.deepEqual(again.els.map((e) => e.ref), first.els.map((e) => e.ref));

    const beta = byName(first.els, "Beta");
    await page.evaluate(() => document.getElementById("b")?.remove());
    const err = await failure(page, { ref: beta.ref });
    assert.equal(err.code, "stale_ref");
    assert.match(err.message, /is gone/);
    assert.equal(await clickHit(page, { ref: byName(first.els, "Alpha").ref }), "alpha");

    // a new document: old refs are stale, new ones never reuse a number
    await page.setContent(`<button>Gamma</button>`);
    assert.equal((await failure(page, { ref: beta.ref })).code, "stale_ref");
    const after = await scanEls(page);
    assert.ok(byName(after.els, "Gamma").ref > Math.max(...first.els.map((e) => e.ref)));
    assert.equal((await failure(page, { ref: 999 })).code, "target_not_found");
  },

  "C3: els --diff lists only what changed": async (newPage) => {
    const page = await newPage(
      `<button id="a">Alpha</button><button id="b">Beta</button><input type="checkbox" aria-label="Agree">`,
    );
    const full = await scanEls(page);
    assert.equal(full.diff, undefined);
    await page.evaluate(() => {
      document.getElementById("b")?.remove();
      const c = document.createElement("button");
      c.textContent = "Gamma";
      document.body.append(c);
      const box = document.querySelector("input");
      if (box) box.checked = true;
    });
    const diff = await scanEls(page, { diff: true });
    assert.deepEqual(diff.diff, { added: 1, removed: [byName(full.els, "Beta").ref], changed: 1 });
    assert.deepEqual(diff.els.map((e) => e.name).sort(), ["Agree", "Gamma"]);
    const quiet = await scanEls(page, { diff: true });
    assert.deepEqual(quiet.diff, { added: 0, removed: [], changed: 0 });
    assert.equal(quiet.rendered, "(no changes since the last scan)");
  },

  "C8: a shadow-DOM button is listed and clickable by ref and text": async (newPage) => {
    const page = await newPage(`<x-card></x-card>`);
    await page.evaluate(() => {
      const root = document.querySelector("x-card")?.attachShadow({ mode: "open" });
      if (root) root.innerHTML = `<button onclick="window.hit='shadow'">Shadow save</button>`;
    });
    const { els } = await scanEls(page);
    assert.equal(await clickHit(page, { ref: byName(els, "Shadow save").ref }), "shadow");
    assert.equal(await clickHit(page, { text: "Shadow save" }), "shadow");
  },

  "C8: a same-origin iframe button is listed with its frame and clickable": async (newPage) => {
    const page = await newPage(
      `<button>Outside</button><iframe name="pay" srcdoc="<button onclick=&quot;parent.hit='inner'&quot;>Pay now</button>"></iframe>`,
    );
    await page.waitForFunction(() => document.querySelector("iframe")?.contentDocument?.querySelector("button") != null);
    const { els } = await scanEls(page);
    const pay = byName(els, "Pay now");
    assert.equal(pay.frame, "pay");
    assert.equal(await clickHit(page, { ref: pay.ref }), "inner");
    assert.equal(await clickHit(page, { text: "Pay now" }), "inner");
  },

  "C8: an open modal lists first and hides the page behind it": async (newPage) => {
    const page = await newPage(`
      <button ${HIT("bg")}>Delete</button><button>Settings</button>
      <div role="dialog" aria-modal="true"><p>Sure?</p><button ${HIT("modal")}>Delete</button><button>Cancel</button></div>`);
    const { els, rendered } = await scanEls(page);
    assert.deepEqual(els.map((e) => e.name), ["Delete", "Cancel"]);
    assert.ok(els.every((e) => e.dialog === true));
    assert.match(rendered, /\(dialog\)/);
    assert.equal(await clickHit(page, { text: "Delete" }), "modal");

    const native = await newPage(`<button>Behind</button><dialog><button>Inside</button></dialog>`);
    await native.evaluate(() => document.querySelector("dialog")?.showModal());
    assert.deepEqual((await scanEls(native)).els.map((e) => e.name), ["Inside"]);
  },

  "C3b: only a modal hides the page; a non-modal open dialog just lists first": async (newPage) => {
    const page = await newPage(`<button>Behind</button><dialog open><button>Inside</button></dialog>`);
    const nonModal = (await scanEls(page)).els;
    assert.deepEqual(nonModal.map((e) => `${e.name}:${e.dialog === true}`), ["Inside:true", "Behind:false"]);

    const modal = await newPage(`<button>Behind</button><dialog><button>Inside</button></dialog>`);
    await modal.evaluate(() => document.querySelector("dialog")?.showModal());
    assert.deepEqual((await scanEls(modal)).els.map((e) => `${e.name}:${e.dialog === true}`), ["Inside:true"]);

    const aria = await newPage(`<button>Behind</button><div role="dialog" aria-modal="true"><button>Inside</button></div>`);
    assert.deepEqual((await scanEls(aria)).els.map((e) => e.name), ["Inside"]);
  },

  "C8: --clickables adds cursor:pointer elements with no role": async (newPage) => {
    const page = await newPage(`<div style="cursor:pointer"><span>Card two</span></div><button>Real</button>`);
    assert.deepEqual((await scanEls(page)).els.map((e) => e.name), ["Real"]);
    const listed = await scanEls(page, { clickables: true });
    assert.deepEqual(listed.els.map((e) => `${e.role}:${e.name}`).sort(), ["button:Real", "clickable:Card two"]);
  },

  "S5: 6,000-element els stays under 150 ms": async (newPage) => {
    const page = await newPage(`<table id="t"></table>`);
    await page.evaluate(() => {
      const table = document.getElementById("t");
      let html = "";
      for (let i = 0; i < 2000; i++) {
        html += `<tr><td><a href="#r${i}">Row ${i}</a></td><td><button>Edit ${i}</button></td><td><input aria-label="Qty ${i}"></td></tr>`;
      }
      if (table) table.innerHTML = html;
    });
    await scanEls(page); // warm: first layout + registry install
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const r = await scanEls(page);
      times.push(performance.now() - t0);
      assert.equal(r.total, 6000);
      assert.equal(r.truncated, true);
    }
    const resolveT0 = performance.now();
    await resolveTarget(page, { text: "Edit 1999" });
    const resolveMs = performance.now() - resolveT0;
    const allT0 = performance.now();
    const all = await scanEls(page, { all: true });
    const allMs = performance.now() - allT0;
    times.sort((a, b) => a - b);
    const median = times[2] ?? Infinity;
    assert.ok(median < 150, `median ${median.toFixed(1)} ms`);
    return (
      `els 6,000 elements: median ${median.toFixed(1)} ms (runs ${times.map((t) => t.toFixed(0)).join(", ")}); ` +
      `els --all ${allMs.toFixed(0)} ms (${all.els.length} rendered of ${all.total}); resolve "Edit 1999" ${resolveMs.toFixed(0)} ms`
    );
  },
};

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

async function runScenarios(): Promise<void> {
  const { chromium } = await import("playwright-core");
  seedOsPasswordCheck(PROFILE_DIR);
  const context: BrowserContext = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chrome",
    headless: true,
    viewport: { width: 1280, height: 800 },
  });
  try {
    for (const [name, scenario] of Object.entries(SCENARIOS)) {
      const pages: Page[] = [];
      const newPage = async (html: string): Promise<Page> => {
        const page = await context.newPage();
        pages.push(page);
        await page.setContent(`<!doctype html><html><body>${html}</body></html>`);
        return page;
      };
      let outcome: Outcome;
      try {
        const info = await scenario(newPage);
        outcome = info ? { name, ok: true, info } : { name, ok: true };
      } catch (err) {
        outcome = { name, ok: false, error: err instanceof Error ? (err.stack ?? err.message) : String(err) };
      }
      for (const page of pages) await page.close().catch(() => undefined);
      process.stdout.write(`${RESULT}${JSON.stringify(outcome)}\n`);
    }
  } finally {
    await context.close();
  }
}

function isOutcome(v: unknown): v is Outcome {
  return (
    typeof v === "object" &&
    v !== null &&
    "name" in v &&
    typeof v.name === "string" &&
    "ok" in v &&
    typeof v.ok === "boolean"
  );
}

if ("bun" in process.versions) {
  const { describe, test } = await import("bun:test");
  const run = spawnSync("node", ["--no-warnings", fileURLToPath(import.meta.url)], {
    encoding: "utf8",
    timeout: 180_000,
    windowsHide: true,
  });
  const outcomes = new Map<string, Outcome>();
  for (const line of run.stdout.split(/\r?\n/)) {
    if (!line.startsWith(RESULT)) continue;
    const parsed: unknown = JSON.parse(line.slice(RESULT.length));
    if (isOutcome(parsed)) outcomes.set(parsed.name, parsed);
  }
  describe("resolve (headless Chrome under Node)", () => {
    for (const name of Object.keys(SCENARIOS)) {
      test(name, () => {
        const outcome = outcomes.get(name);
        if (!outcome) throw new Error(`node produced no result (exit ${run.status})\n${run.stderr}`);
        if (outcome.info) console.log(outcome.info);
        if (!outcome.ok) throw new Error(outcome.error);
      });
    }
  });
} else {
  await runScenarios();
}
