# bx audit implementation

- **Date:** 2026-10-12
- **Status:** active
- **Type:** plan
- **What:** bosun run implementing the 41 approved audit items, plus research on Chrome speed, .NET and a recording redesign

Status: active (2026-10-12). Lead: Opus. Agents: scout (opus-xhigh), core (opus-high); later resolver, agentkit, infra (opus-high). Board: down

Sal, 2026-10-12 (verbatim, abridged only by cutting):
- "Approved (41)" — every item in the audit artifact https://claude.ai/artifact/CKNcQXRXc77WSYXk757LeU
- "V1: the current recording flow sucks, id love a better solution"
- ".net is an idea, lets consider it. use xhigh agent. i need this thing to be lightning fast. is there any way to make chrome faster? lighter? idk"
- "implement it using /bosun only when needed."

The audit page (item text = the spec): `C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\bx-audit.html` (ITEMS array).

## Shape

| Phase | Who | What | Ends when |
| --- | --- | --- | --- |
| 0 | Lead | protocol.ts contract for every item; live bx pinned to G:\code\bx-live | Typecheck green |
| 0 | scout | Research: Chrome faster/lighter, .NET case, recording redesign | Report in plans/2026-10-12-speed-research.md |
| 1 (sample) | core + lead | Wave 1: R1 R3 R4 S1 S6 O3 O4 D2 (core); R5 S2 S3 C7 A1-cli (lead) | Sal approves the sample |
| 2 | core, resolver, agentkit, infra | Waves 2–4 by file ownership | Each slice ready and passed |
| 3 | Lead | V1 recording per scout's design; gate, push, kit | Pushed |

Cap: 5 agents + board-scribe. Checkpoint for Sal: after the sample (diff summary + before/after latency numbers + self-heal demo).

Stop plan: TaskStop each agent, then `bx --profile <its profiles> stop`, delete its scratch profiles. Background jobs listed in the Ledger.

## Live tool freeze

Sal's global `bx` must not run half-edited code. `G:\code\bx-live` is a `git archive a80f037` export with its own node_modules. The global link `C:\Users\dested\.bun\install\global\node_modules\bx` is repointed there for the run (Sal runs the relink; classifier blocked the lead). Refresh it only from a gated sha. Relink to `G:\code\bx` at the end.

Agents never use the global `bx`. They run `bun G:/code/bx/src/cli.ts --profile <own profile> …` and the smoke suite with `BX_TEST_PROFILE=<own profile>`.

## Ownership

| Path | Owner |
| --- | --- |
| `src/daemon/session.ts`, `src/daemon/daemon.ts`, `src/daemon/serialize.ts` (new) | core |
| `src/daemon/resolve.ts` (new), `src/daemon/distill.ts`, `tests/resolve.test.ts` (new) | resolver (phase 2) |
| `src/agent/**`, `src/bench/**` | agentkit (phase 2) |
| `src/daemon/observe.ts`, `src/daemon/debug.ts`, `src/daemon/record.ts`, `src/daemon/actionLog.ts`, `src/daemon/orphans.ts` (new), `src/maintenance.ts` (new), `src/flows/**`, `tests/flows.test.ts`, `tests/record.test.ts` | infra (phase 2) |
| `plans/2026-10-12-speed-research.md`, scout scratch | scout |
| `src/protocol.ts`, `src/cli.ts`, `src/client.ts`, `tests/smoke.test.ts`, `skill/SKILL.md`, cliffnotes kit, decisions.md, plans/ (except scout's file), package.json, bun.lock | Lead |

A file nobody owns: ask the lead before touching it.

## Rules for every agent

- Re-read your section and Standing answers before each item and before asking.
- Edit only your owned paths. Scratch goes in `C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\<your name>\`.
- Commit only with `bash ~/.claude/sal/bin/commit-paths.sh "<msg> (<your name>)" <your paths>`. No push, stash, reset, checkout --, restore, clean, amend or worktree.
- Shared files (protocol.ts above all): send the lead the exact lines; the lead commits them.
- Browser checks: `bun G:/code/bx/src/cli.ts --profile <yourname>-dev --headless …`. Never the global `bx`, never another agent's profile, never `bx stop --all`, never kill a Chrome you didn't start. Delete your profiles (`C:\Users\dested\.bx\profiles\<name>`, its log and run file) when done.
- The daemon runs under Node 22 type stripping: node:* only, no Bun APIs, no enums/namespaces/parameter properties in `src/daemon/**`.
- No `any`, no papering `as`, no ts-ignore. `bun x tsc --noEmit` silent before every `ready`.
- No remote machines.
- Report in ≤ 10 lines: `ready <id> <sha> <one line> [doubts]` or `blocked <id>: <what>`.

## scout: opus-xhigh, research only

**Goal.** Answer Sal's three open questions with measurements on this machine, and recommend what to build.

**Read first.** `G:\code\bx\cliffnotes.md`, `G:\code\bx\decisions.md` (Node daemon, recording entries), `G:\code\bx\src\daemon\session.ts` (launch at ~163, relaunch ~1085), `G:\code\bx\src\daemon\record.ts`, `G:\code\bx\src\client.ts`, the audit page above (items S2, S3, V1, D2, and its "Considered and set aside" .NET card).

**Questions.**
1. **Chrome faster and lighter.** Measure, for each candidate: daemon cold start to first command, per-command round trip (`js 1`, click, els), RSS per browser and per extra tab, profile size growth. Candidates at minimum: the current launch; `chrome-headless-shell` for headless daemons (install into your scratch with `npx @puppeteer/browsers install chrome-headless-shell@stable --path <scratch>`); flag sets (`--disable-background-networking`, `--disable-component-update`, `--disable-default-apps`, `--disable-sync`, `--disable-features=` lists such as Translate/OptimizationHints/MediaRouter, `--renderer-process-limit`, site-isolation off, `--disk-cache-size`, `--js-flags=--max-old-space-size`); Playwright `page.evaluate` vs a raw CDP `Runtime.evaluate` over the same connection (is Playwright's per-call overhead material?); pre-warmed spare tab for `tabNew`. For each, say what it could break (logins, extensions, GPU/canvas, video, Windows password seed).
2. **.NET.** Where would C# genuinely win? (a) Build a minimal NativeAOT client in scratch (dotnet 10 SDK is installed) that reads `C:\Users\dested\.bx\run\<profile>.json` and POSTs one `/cmd`; measure cold start against `bun src/cli.ts js 1` (~114 ms) and a bare `bun -e 0` (~59 ms). (b) Estimate or measure a .NET daemon speaking CDP directly vs the Node+Playwright daemon (memory, latency); is a rewrite worth it? (c) Anything else .NET is clearly better for here (process/job-object cleanup of orphan Chrome, a tray monitor). Make the case or say no, with numbers.
3. **Recording redesign (V1).** Sal: "the current recording flow sucks". Run the current flow once on the fixture (per verify.md "Recording e2e", with your own profile) and list what's painful. Design a better one: no context relaunch (CDP `Page.startScreencast` or similar), instant start/stop, which tab, optional rolling buffer ("save the last N seconds"), markers, output formats, how the transcript and the video-to-prompt distill fit. Prototype the capture core in scratch if it's cheap, and measure fps, CPU and file size.

**Owns.** `G:\code\bx\plans\2026-10-12-speed-research.md` and your scratch folder. Read-only everywhere else. Don't commit; the lead commits the report.

**Rules.** Profiles named `scout-*` only, all deleted when done. Don't install anything globally; npm/npx downloads go into your scratch. No changes to Sal's Chrome, profiles or settings.

**Done when.** The report exists with a header block (Date, Status: active, Type: analysis, What), a recommendations table first (change · measured gain · risk · effort), then evidence per question with the scripts' paths. Report to the lead in ≤ 10 lines.

## core: opus-high

**Goal.** The daemon-side half of wave 1, as the run's sample: bx stops failing on dead browsers, busy pages and redirects, and stops sleeping 150 ms per action.

**Read first.** `G:\code\bx\cliffnotes.md` (Gotchas: runtime split, OS-password seed, tab close), the audit ITEMS for R1 R3 R4 S1 S6 O3 O4 D2, `G:\code\bx\src\protocol.ts` (the lead has added the wire fields below).

**Decisions already made.**
- R1: `context.on("close")` (and a failed command whose error matches /Target page, context or browser has been closed|Browser has been closed/) marks the session dead. The next command relaunches through the same path as boot (OS-password seed first, same headless mode, same profile), with no tab restore beyond one blank page, and the envelope carries `relaunched: true`. Two failed relaunches in a row → error code `browser_dead`. Pinned tab ids from the dead browser → existing code `no_page`, message "tab <id> was lost when the browser closed; open a new one". `status` reports `browserRunning` accurately and `relaunches` (count since daemon start).
- R2 (daemon half): if launch fails with "Opening in existing browser session" / profile-in-use, call `clearProfileLocks(profileDir)` from `src/daemon/orphans.ts` (infra writes it in phase 2; for now leave a `// R2: orphans.ts` call site behind a small local function that returns false) and retry once.
- R3: daemon reads header `x-bx-deadline-ms` (default 10000; clamp 1000..600000). `drive` gets timeoutMs+5000, `recordStart`/`recordStop` none. On expiry respond error code `deadline`, message `deadline <n> ms exceeded during <step>` where step is the last label passed to a tiny `step(label)` tracker in the command (e.g. "resolve target", "click", "settle"). The underlying promise is left to settle and its result discarded. `status` must not evaluate page JS: title comes from the S6 cache. `text` gets `timeout: BUDGET.DEFAULT_TIMEOUT_MS` on `innerText`.
- R4: `open` = `goto(url, {waitUntil:"load", timeout:15000})` then wait until the main frame URL hasn't changed for 300 ms (cap 3000 ms total); `OpenResult.redirectedTo` = final URL when it differs from the requested one (after normalization). `js` retries once on /Execution context was destroyed|Cannot find context/ after `waitForLoadState("load", {timeout:5000})`.
- S1: replace `sleep(SETTLE_MS)` with `settle(page, capMs)`: in-page, resolve when there have been no DOM mutations (MutationObserver on documentElement, subtree, childList+attributes+characterData) AND no in-flight fetch/XHR started by the action for 50 ms; cap default 1500 ms; never less than 0. Track in-flight requests daemon-side via the page's `request`/`requestfinished`/`requestfailed` events counted from action start, not in-page patching. `mouse move`, `key`, and `press` of a lone modifier (Shift, Control, Alt, Meta) skip settle (settledMs 0). Action commands accept `settle?: number` (cap ms; 0 disables). `ActionResult.settledMs` = measured wait.
- S6: per-page title cache updated on `framenavigated` (main frame) and `domcontentloaded`, and refreshed inside `settle()`'s in-page evaluate (return `document.title` alongside). `pageInfo` never calls `page.title()`.
- O3: keep the existing prefixes so old log parsers still match, and append: `<verb> ok 172ms tab=3 settle=40ms` and `<verb> failed: <code> <message> (172ms tab=3)`.
- O4: `appendAction` redacts `value` in cmdJson for fills into `type=password` inputs: `"value":"•••"`, and the human text already shows dots. Synthesis already treats the REDACTED_MARK in text.
- D2: launch args gain `--disk-cache-size=67108864` (both launch paths).
- A1 (daemon half): new `src/daemon/serialize.ts` exporting the in-page serializer source as a string, and `js` becomes: evaluate `(async () => (<expr>))()`; on SyntaxError evaluate as an async function body where the last expression statement's value is returned (rewrite: if the body's last top-level statement is an expression statement, prefix it with `return `; find it with a small tokenizer-free heuristic: split on the last top-level `;` or newline outside strings/brackets; if that fails, return undefined). Results go through the in-page serializer: Element → `"<tag#id.class \"name\">"` (name = aria-label || trimmed textContent, 40 chars); NodeList/HTMLCollection/arrays → arrays; Map → `{"__map":[[k,v]…]}`; Set → `{"__set":[…]}`; cycles → `"[Circular]"`; BigInt → `"123n"`; functions → `"[Function name]"`; undefined in arrays → null; depth > 8 → `"[Depth]"`. Truncation is structural against `BUDGET.JS_MAX_CHARS`: arrays keep the first N items then a final string `"… <k> more"`; long strings cut with `"…"`; objects keep the first keys then `"…": "<k> more keys"`. Output always parses as JSON. `JsResult.value` stays a JSON string.

**Owns.** `src/daemon/session.ts`, `src/daemon/daemon.ts`, `src/daemon/serialize.ts`, `tests/serialize.test.ts` (new, no browser: feed the serializer through `node:vm` or evaluate it in a headless page via your own profile).

**Done when.**
- `bun x tsc --noEmit` silent.
- `BX_TEST_PROFILE=core-smoke bun test tests/smoke.test.ts` passes, plus `bun test tests/actionLog.test.ts tests/record.test.ts tests/flows.test.ts tests/serialize.test.ts`.
- Re-run the audit experiments with your own profile and paste numbers: no-op click/press/mouse-move latency before vs after; kill Chrome (only the one under your daemon: its pid via `wmic`/CIM filtered by your profile's `--user-data-dir`) then `js 1` succeeds with `relaunched: true`; busy-loop page (`while(true){}` via `js` in a second tab) → `js` returns `deadline` within deadline+1 s and `status` answers in < 500 ms; client-redirect page opens 8/8; `js "const a = 2; a * 21"` → `42`; DOM node / Map / circular / 5,000-item array all return valid JSON.
- Each item a separate commit `R1: … (core)` etc.

**Don't.** Touch protocol.ts (send lines), cli.ts or client.ts; change command names or existing result fields; add dependencies; push.

## Standing answers

- (2026-10-12, lead) Batch mode is client-only: `bx -` and `bx do` loop POST /cmd in one process. No `/batch` endpoint. Applies to: all.
- (2026-10-12, lead) Ref syntax: `@12` canonical; bare digits = `{ref, orText}`. Applies to: resolver, lead.

## Ledger (lead, updated 2026-10-12)

Board: down · Last pushed: b3dc301 (origin/main; local main ahead, unpushed) · Gate: n/a

| Agent | Model | Owns | Item now | Last sha / artifact | Status |
| --- | --- | --- | --- | --- | --- |
| scout | opus-xhigh | research report | Q1–Q3 | — | running |
| core | opus-high | session.ts, daemon.ts, serialize.ts | wave 1 sample | — | running |
| lead | — | cli, client, protocol, constants, script | R5 S2 S3 C7 A1-cli | aafd640 | done: CLI js 1 94→67 ms (bun floor 45), bx do 20 cmds 105 ms |

Live tool: global bx → G:\codex-live (a80f037), relinked by Sal 2026-10-12.
Background jobs: none
Waiting on Sal: sample approval (after core reports)
Next: review core's sample, then spawn resolver, agentkit, infra
