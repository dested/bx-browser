// The shared argv core (src/argv/): parsing, rendering and the daemon's
// /argv entry, against a fake daemon (no browser). Plus the live parity check,
// bx.exe vs the Bun CLI on the fixture, which runs only with
// BX_PARITY_PROFILE=<profile> and a built dist/bx.exe:
//
//   BX_PARITY_PROFILE=frontdoor-dev bun test tests/argv.test.ts

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CliError } from "../src/argv/errors.ts";
import { extractGlobals, type Globals, repairMsysArgs, wantsHelp } from "../src/argv/parse.ts";
import { serveArgv } from "../src/argv/serve.ts";
import { readRunFile } from "../src/client.ts";
import { isServed, runVerb, type VerbIO } from "../src/argv/verbs.ts";
import type { ActionResult, ArgvResponse, Cmd, CmdResult } from "../src/protocol.ts";

const ARGV_DIR = path.resolve(import.meta.dir, "..", "src", "argv");

function globals(over: Partial<Globals> = {}): Globals {
  return { profile: "p", headless: undefined, json: false, deadlineMs: undefined, batch: false, ...over };
}

const ACTION: ActionResult = {
  navigated: false,
  page: { index: 0, id: 1, url: "http://127.0.0.1/x", title: "X", active: true },
  consoleErrors: [],
  settledMs: 0,
  delta: { added: 2, removed: 1 },
};

/** A VerbIO whose daemon answers every command with `answer`, recording what it was sent. */
function fakeIO(answer: (c: Cmd) => CmdResult, cwd = "C:\\work"): VerbIO & { sent: Cmd[]; out: string; err: string } {
  const state = { sent: [] as Cmd[], out: "", err: "" };
  const io = {
    get sent() {
      return state.sent;
    },
    get out() {
      return state.out;
    },
    get err() {
      return state.err;
    },
    send: async <T>(c: Cmd): Promise<CmdResult<T>> => {
      state.sent.push(c);
      // Test double: the fake daemon's payload is whatever the test chose for T.
      return answer(c) as CmdResult<T>;
    },
    stdout: (chunk: string) => {
      state.out += chunk;
    },
    stderr: (chunk: string) => {
      state.err += chunk;
    },
    cwd,
    env: {},
    elapsedMs: () => 7,
  };
  return io;
}

describe("parse", () => {
  test("globals come out from anywhere; the rest keeps its order", () => {
    const { globals: g, rest } = extractGlobals(["click", "--profile", "a", "Save", "--json", "--headless", "--deadline", "2000"]);
    expect(g).toEqual({ profile: "a", headless: true, json: true, deadlineMs: 2000, batch: false });
    expect(rest).toEqual(["click", "Save"]);
  });

  test("bad globals are usage errors", () => {
    expect(() => extractGlobals(["--profile"])).toThrow(CliError);
    expect(() => extractGlobals(["--deadline", "50", "js", "1"])).toThrow(CliError);
  });

  test("MSYS repair strips exactly the EXEPATH prefix, only under MSYSTEM", () => {
    const env = { MSYSTEM: "MINGW64", EXEPATH: "C:\\Program Files\\Git" };
    expect(repairMsysArgs(["open", "C:/Program Files/Git/tasks", "//div"], env)).toEqual(["open", "/tasks", "//div"]);
    expect(repairMsysArgs(["C:/Program Files/Git/tasks"], { EXEPATH: env.EXEPATH })).toEqual([
      "C:/Program Files/Git/tasks",
    ]);
  });

  test("help anywhere", () => {
    expect(wantsHelp(["click", "-h"])).toBe(true);
    expect(wantsHelp(["click", "--helpful"])).toBe(false);
  });

  test("served verbs: everything but the CLI's own and js from stdin", () => {
    for (const verb of ["run", "agent", "stop", "gc", "doctor", "profiles", "install-skill", "-", "do", "help"]) {
      expect(isServed(verb, [])).toBe(false);
    }
    expect(isServed("js", ["-"])).toBe(false);
    expect(isServed("js", ["@x.js"])).toBe(true);
    expect(isServed("click", ["Save"])).toBe(true);
    expect(isServed("nonsense", [])).toBe(true);
  });
});

describe("runVerb", () => {
  test("click: the Cmd it sends and the human output", async () => {
    const io = fakeIO(() => ({ ok: true, data: ACTION }));
    const code = await runVerb(globals(), "click", ["Save", "--exact", "--settle", "0"], io);
    expect(code).toBe(0);
    expect(io.sent).toEqual([{ cmd: "click", target: { text: "Save", exact: true }, timeoutMs: undefined, settle: 0 }]);
    expect(io.out).toBe('✓ clicked "Save"\ndom +2 −1\n');
    expect(io.err).toBe("");
  });

  test("--json carries ms; errors print code, message and near matches", async () => {
    const json = fakeIO(() => ({ ok: true, data: { value: "1", truncated: false } }));
    expect(await runVerb(globals({ json: true }), "js", ["1"], json)).toBe(0);
    expect(json.out).toBe('{"value":"1","truncated":false,"ms":7}\n');

    const near = { ref: 3, tag: "button", role: "button", name: "Save draft", state: ["disabled"] };
    const failing = fakeIO(() => ({
      ok: false,
      error: { code: "target_not_found", message: "no match for Sav", nearMatches: [near] },
    }));
    expect(await runVerb(globals(), "click", ["Sav"], failing)).toBe(1);
    expect(failing.err).toBe(
      '✗ target_not_found: no match for Sav\ndid you mean:\n  [3] button "Save draft" (disabled)\n',
    );
  });

  test("expect: a failed assertion is exit 1 with the detail", async () => {
    const io = fakeIO(() => ({ ok: true, data: { pass: false, detail: "url is /a" } }));
    expect(await runVerb(globals(), "expect", ["url", "/b"], io)).toBe(1);
    expect(io.out).toBe('✗ expect url "/b" — url is /a — --timeout <ms> to adjust\n');
  });

  test("paths resolve against the caller's cwd, not the process's", async () => {
    const io = fakeIO(() => ({ ok: true, data: { path: "x", width: 1, height: 1, bytes: 10 } }), "D:\\caller");
    await runVerb(globals(), "snap", ["shot.png"], io);
    expect(io.sent[0]).toMatchObject({ cmd: "snap", path: path.resolve("D:\\caller", "shot.png") });
  });

  test("js @file reads relative to the caller's cwd", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bx-argv-"));
    fs.writeFileSync(path.join(dir, "probe.js"), "  document.title\n");
    const io = fakeIO(() => ({ ok: true, data: { value: '"T"', truncated: false } }), dir);
    expect(await runVerb(globals(), "js", ["@probe.js"], io)).toBe(0);
    expect(io.sent).toEqual([{ cmd: "js", expression: "document.title" }]);
    fs.rmSync(path.join(dir, "probe.js"));
    fs.rmdirSync(dir);
  });

  test("unknown verb prints the usage to stderr, exit 2", async () => {
    const io = fakeIO(() => ({ ok: true, data: null }));
    expect(await runVerb(globals(), "frobnicate", [], io)).toBe(2);
    expect(io.err.startsWith('unknown command "frobnicate"\n\nbx — browser automation')).toBe(true);
    expect(io.sent).toEqual([]);
  });
});

describe("serveArgv", () => {
  type RunCmd = (body: unknown, clientHeader: string, deadlineHeader: string) => Promise<CmdResult>;
  function deps(runCmd: RunCmd, headless = true) {
    return { profile: "p", headless, runCmd };
  }
  const okJs: RunCmd = async () => ({ ok: true, data: { value: "1", truncated: false } });

  test("fallback for anything the CLI must run", async () => {
    const fb: ArgvResponse = { fallback: true };
    const d = deps(okJs);
    expect(await serveArgv({ argv: ["--profile", "p", "stop"], cwd: "C:\\", env: {} }, d)).toEqual(fb);
    expect(await serveArgv({ argv: ["--profile", "p", "js", "-"], cwd: "C:\\", env: {} }, d)).toEqual(fb);
    expect(await serveArgv({ argv: ["--profile", "p", "click", "-h"], cwd: "C:\\", env: {} }, d)).toEqual(fb);
    expect(await serveArgv({ argv: ["--profile", "other", "js", "1"], cwd: "C:\\", env: {} }, d)).toEqual(fb);
    expect(await serveArgv({ argv: ["--profile"], cwd: "C:\\", env: {} }, d)).toEqual(fb);
    expect(await serveArgv({ argv: ["--profile", "p"], cwd: "C:\\", env: {} }, d)).toEqual(fb);
    expect(await serveArgv({ argv: "js 1", cwd: "C:\\" }, d)).toEqual(fb);
  });

  test("serves a verb: output, client tag, deadline header, timing", async () => {
    const seen: { body: unknown; tag: string; deadline: string }[] = [];
    const d = deps(async (body, tag, deadline) => {
      seen.push({ body, tag, deadline });
      return { ok: true, data: { value: "1", truncated: false } };
    });
    const res = await serveArgv(
      {
        argv: ["--profile", "p", "js", "1"],
        cwd: "C:\\work",
        pid: 42,
        env: { BX_TIMING: "1", CLAUDE_CODE_SESSION_ID: "s1", IGNORED: "x" },
      },
      d,
    );
    expect(res).toMatchObject({ stdout: "1\n", exit: 0 });
    expect("stderr" in res && /^\(\d+ms\)\n$/.test(res.stderr)).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.body).toEqual({ cmd: "js", expression: "1" });
    expect(JSON.parse(decodeURIComponent(seen[0]?.tag ?? ""))).toEqual({ session: "s1", cwd: "C:\\work", pid: 42, via: "js" });
    expect(seen[0]?.deadline).toBe("10000");
  });

  test("an explicit --headless against a headed daemon prints the CLI's note", async () => {
    const res = await serveArgv({ argv: ["--profile", "p", "--headless", "js", "1"], cwd: "C:\\", env: {} }, deps(okJs, false));
    expect(res).toEqual({
      stdout: "1\n",
      stderr: 'note: reusing the running headed daemon for "p" — `bx --profile p stop` first to change mode\n',
      exit: 0,
    });
  });

  test("results pass the client's envelope check, so extra fields never print", async () => {
    const d = deps(async () => ({
      ok: false,
      error: {
        code: "ambiguous",
        message: "2 matches",
        nearMatches: [{ ref: 1, tag: "a", role: "link", name: "A", state: [], box: { x: 1 } }],
      },
    }));
    const res = await serveArgv({ argv: ["--profile", "p", "--json", "click", "A"], cwd: "C:\\", env: {} }, d);
    expect(res).toMatchObject({ exit: 1, stderr: "" });
    expect("stdout" in res ? JSON.parse(res.stdout) : null).toEqual({
      code: "ambiguous",
      message: "2 matches",
      nearMatches: [{ ref: 1, tag: "a", role: "link", name: "A", state: [] }],
      ms: expect.any(Number),
    });
  });

  test("a usage error inside a verb renders like the CLI", async () => {
    const res = await serveArgv({ argv: ["--profile", "p", "click"], cwd: "C:\\", env: {} }, deps(okJs));
    expect(res).toEqual({ stdout: "", stderr: "✗ usage: bx click <target>\n", exit: 2 });
  });
});

test("src/argv loads under Node's type stripping (the daemon imports it)", () => {
  const script = [
    `const m = await import(${JSON.stringify(new URL(`file:///${path.join(ARGV_DIR, "serve.ts").replace(/\\/g, "/")}`).href)});`,
    "console.log(typeof m.serveArgv);",
  ].join("\n");
  const r = spawnSync("node", ["--input-type=module", "-e", script], { encoding: "utf8", windowsHide: true });
  expect(r.stderr).not.toContain("SyntaxError");
  expect(r.stdout.trim()).toBe("function");
});

// ---------------------------------------------------------------------------
// Live parity: every served verb through `bun src/cli.ts` and `dist/bx.exe`
// ---------------------------------------------------------------------------

const PARITY_PROFILE = process.env.BX_PARITY_PROFILE;
const REPO = path.resolve(import.meta.dir, "..");
const EXE = path.join(REPO, "dist", "bx.exe");
const CLI = path.join(REPO, "src", "cli.ts");

interface Run {
  stdout: string;
  stderr: string;
  exit: number | null;
}

function runWith(front: "bun" | "exe", argv: string[], env: Record<string, string> = {}): Run {
  const file = front === "bun" ? "bun" : EXE;
  const args = front === "bun" ? [CLI, ...argv] : argv;
  const r = spawnSync(file, args, {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, BX_TIMING: "", ...env },
  });
  return { stdout: r.stdout, stderr: r.stderr, exit: r.status };
}

/**
 * The fields that can't match between two runs by design: timings (ms,
 * settle, drive's elapsed), the daemon's never-reused page and request ids,
 * and the uptime clock.
 */
function normalize(text: string): string {
  return text
    .replace(/"ms":\d+/g, '"ms":N')
    .replace(/\(\d+ms\)/g, "(Nms)")
    .replace(/"(id|uptimeMs|settledMs|elapsedMs)":\d+/g, '"$1":N')
    .replace(/satisfied after \d+\.\ds/g, "satisfied after Ns")
    .replace(/new tab \d+/g, "new tab N")
    .replace(/running, up \d+(m\d+)?s/g, "running, up N");
}

interface ParityCase {
  name: string;
  argv: string[];
  /** Run through the Bun CLI before each front's run (after the reset). */
  setup?: string[][];
  /** Read-only: both fronts see the same state, so no reset between them. */
  readOnly?: boolean;
  env?: Record<string, string>;
}

describe.if(PARITY_PROFILE !== undefined)("parity: bx.exe vs bun src/cli.ts", () => {
  const profile = PARITY_PROFILE ?? "";
  const g = ["--profile", profile, "--headless"];
  let fixture = "";
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bx-parity-"));
  const jsFile = path.join(scratch, "probe.js");
  fs.writeFileSync(jsFile, "const t = document.title;\nt.length");

  const bun = (...argv: string[]): Run => runWith("bun", [...g, ...argv]);
  function reset(setup: string[][] = []): void {
    const steps = [["tab", "close", "--all"], ["open", `${fixture}#/login`], ["js", "localStorage.clear(); 1"], ["reload"], ...setup];
    for (const argv of steps) {
      const r = bun(...argv);
      if (r.exit !== 0) throw new Error(`setup ${argv.join(" ")}: ${r.stderr}`);
    }
  }

  const login = [
    ["fill", "Email", "demo@taskbox.test"],
    ["fill", "Password", "hunter2"],
    ["click", "Sign in"],
    ["wait", "Add task"],
  ];
  const cases: ParityCase[] = [
    { name: "open", argv: ["open", "<fixture>#/login"] },
    { name: "els", argv: ["els"] },
    { name: "els --all --filter", argv: ["els", "--all", "--filter", "Sign"] },
    { name: "els --clickables", argv: ["els", "--clickables"] },
    { name: "els --diff", argv: ["els", "--diff"], setup: [["els"]] },
    { name: "click: login error", argv: ["click", "Sign in"] },
    { name: "click: navigates", argv: ["click", "Sign in", "--then", "els"], setup: login.slice(0, 2) },
    { name: "fill", argv: ["fill", "Email", "demo@taskbox.test"] },
    { name: "press", argv: ["press", "Enter"], setup: [...login, ["fill", "What needs doing?", "milk"]] },
    { name: "select: not a select", argv: ["select", "Email", "x", "--timeout", "500"] },
    { name: "wait ms", argv: ["wait", "10"], readOnly: true },
    { name: "wait text", argv: ["wait", "Sign in"], readOnly: true },
    { name: "wait --idle", argv: ["wait", "--idle"], readOnly: true },
    { name: "wait --url", argv: ["wait", "--url", "login"], readOnly: true },
    { name: "wait --js", argv: ["wait", "--js", "1"], readOnly: true },
    { name: "wait --gone timeout", argv: ["wait", "--gone", "Sign in", "--timeout", "500"], readOnly: true },
    { name: "expect pass", argv: ["expect", "text", "Sign in"], readOnly: true },
    { name: "expect fail", argv: ["expect", "url", "nowhere", "--timeout", "300"], readOnly: true },
    { name: "text", argv: ["text"], readOnly: true },
    { name: "text --md", argv: ["text", "--md"], readOnly: true },
    { name: "text target", argv: ["text", "testid:login-form"], readOnly: true },
    { name: "console", argv: ["console", "--all"], readOnly: true },
    { name: "net", argv: ["net", "--all"], readOnly: true },
    { name: "net --failed", argv: ["net", "--failed"], readOnly: true },
    { name: "js", argv: ["js", "document.title"], readOnly: true },
    { name: "js statements", argv: ["js", "const a = 2; a * 21"], readOnly: true },
    { name: "js @file", argv: ["js", `@${jsFile}`], readOnly: true },
    { name: "js throws", argv: ["js", 'throw new Error("boom")'], readOnly: true },
    { name: "back", argv: ["back"], setup: login },
    { name: "reload", argv: ["reload"] },
    { name: "tabs", argv: ["tabs"], readOnly: true },
    { name: "tab new", argv: ["tab", "new", "<fixture>#/login"] },
    { name: "tab select", argv: ["tab", "0"], setup: [["tab", "new"]] },
    { name: "tab close", argv: ["tab", "close"], setup: [["tab", "new"]] },
    { name: "mouse", argv: ["mouse", "click", "5", "5"] },
    { name: "drag", argv: ["drag", "5", "5", "20", "20", "--steps", "2"] },
    { name: "key", argv: ["key", "down", "w"] },
    { name: "wheel", argv: ["wheel", "100"] },
    { name: "drive", argv: ["drive", "--install", "window.__n = 0", "--until", "++window.__n > 2", "--poll", "20"] },
    { name: "snap", argv: ["snap", path.join(scratch, "s.png")], readOnly: true },
    { name: "status", argv: ["status"], readOnly: true },
    { name: "near matches", argv: ["click", "Sign inn", "--exact", "--timeout", "300"], readOnly: true },
    { name: "usage error", argv: ["click"], readOnly: true },
    { name: "bad --then", argv: ["click", "x", "--then", "nope"], readOnly: true },
    { name: "unknown verb", argv: ["frobnicate"], readOnly: true },
    { name: "fallback: bad --deadline", argv: ["--deadline", "5", "js", "1"], readOnly: true },
    { name: "fallback: help", argv: ["els", "--help"], readOnly: true },
    { name: "BX_TIMING", argv: ["js", "1"], readOnly: true, env: { BX_TIMING: "1" } },
  ];

  test(
    "every served verb prints the same bytes and exit code, human and --json",
    () => {
      const first = bun("js", "1");
      if (first.exit !== 0) throw new Error(first.stderr);
      // The daemon serves the fixture on its own port.
      const run = readRunFile(profile);
      if (run === null) throw new Error(`no run file for ${profile}`);
      fixture = `http://127.0.0.1:${run.port}/fixture`;
      const diffs: string[] = [];
      let compared = 0;
      let retried = 0;
      for (const c of cases) {
        for (const json of [false, true]) {
          const argv = [...g, ...(json ? ["--json"] : []), ...c.argv.map((a) => a.replace("<fixture>", fixture))];
          // The daemon itself isn't byte-stable run to run (a settle that ends
          // a frame earlier registers refs in a different order), so a case
          // counts as a diff only when three fresh pairs all disagree.
          const label = `${c.name}${json ? " --json" : ""}`;
          let last: string[] = [];
          for (let attempt = 0; attempt < 3; attempt++) {
            const runs: Run[] = [];
            for (const front of ["bun", "exe"] as const) {
              if (!c.readOnly || runs.length === 0) reset(c.setup);
              runs.push(runWith(front, argv, c.env));
            }
            const [a, b] = runs;
            if (a === undefined || b === undefined) break;
            last = [];
            for (const stream of ["stdout", "stderr"] as const) {
              if (normalize(a[stream]) !== normalize(b[stream])) {
                last.push(`${label} ${stream}:\n  bun ${JSON.stringify(a[stream])}\n  exe ${JSON.stringify(b[stream])}`);
              }
            }
            if (a.exit !== b.exit) last.push(`${label} exit: bun ${a.exit} exe ${b.exit}`);
            if (last.length === 0) break;
            retried++;
          }
          compared++;
          diffs.push(...last);
        }
      }
      console.log(`parity: ${compared} comparisons, ${diffs.length} diffs, ${retried} retries`);
      expect(diffs).toEqual([]);
    },
    600_000,
  );
});
