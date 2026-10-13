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

## Phase 2 contract (lead lands it in protocol.ts after the sample)

All optional fields; the full text is in `G:\code\bx\src\protocol.ts` once landed. Summary:
- Targets gain `{testid}`, `{role, name?}`, `{label}` and `exact?`/`first?` on text/testid/role/label. CLI prefixes `text:`, `testid:`, `label:`, `role:<role>[:<name>]`, flags `--exact`, `--first`.
- New error code `ambiguous` (nearMatches = the tied candidates, registered as refs).
- `El.frame?`, `El.dialog?`. `els` gains `diff?`, `clickables?`; `ElsResult.diff?: {added, removed: number[], changed}`.
- Actions gain `then?: "els"|"text"|"snap"` and `until?: string`. `ActionResult.delta?: ActionDelta` (url, title, dialog opened/closed, alerts ≤3, added, removed, focused, newTab) and `ActionResult.then?`.
- `wait` gains `idle`, `gone` (Target), `url`, `js`.
- `text` gains `target`, `md`, `timeoutMs` (selector kept, target wins).
- `snap` gains `target`, `jpeg`, `quality`, `stable`; `SnapResult.format?`.
- `console`/`net` gain `allTabs` and the tab pin; `net` gains `all`; entries gain `tab?`, NetEntry `id?`, `resourceType?`. New cmd `netBody {id}` → `NetBodyResult`.

## resolver: opus-high (phase 2)

**Goal.** Targets resolve to the element the caller meant: exact beats fuzzy, hidden never wins, ties are reported, and refs track the element itself across scans. `els` sees shadow DOM, iframes and modals, and stays fast on huge pages.

**Read first.** The audit ITEMS C1 C2 C3 C7 C8 S5; `G:\code\bx\src\daemon\session.ts` resolveTarget (~341), nearMatches, register/refsFor; `G:\code\bx\src\daemon\distill.ts`; the Targets comment in `G:\code\bx\src\protocol.ts`.

**Decisions already made.**
- New `src/daemon/resolve.ts` (Node runtime rules) exports: `pageRefs(page)` state; `scanEls(page, {all, filter, diff, clickables}) → ElsResult`; `resolveTarget(page, target, {timeoutMs}) → {locator, stable}`; `class ResolveError extends Error { code: "target_not_found" | "stale_ref" | "ambiguous"; nearMatches?: El[] }`. distill.ts keeps the in-page scan, rewritten.
- Identity refs: an in-page registry (`window.__bx`, installed lazily by evaluate, re-installed per document and per frame) keeps WeakRef id→element and WeakMap element→id. Ids come from a per-page daemon counter passed in, so a ref number is never reused within a tab across navigations. A ref is stale only when its element is gone or disconnected: `stale_ref` "ref 12 is gone (the element left the page) — re-run els". Refs from an earlier document are stale the same way. No generation bump on scan.
- `{ref, orText}`: the ref when live, else orText as a text target.
- Resolution: one in-page pass scores candidates per the protocol Targets comment. The winner gets attribute `data-bx-ref="<id>"` and the locator is `frame.locator('[data-bx-ref="<id>"]')`. If nothing matches, poll every 100 ms up to min(timeoutMs ?? 5000, 2000) ms, then `target_not_found` with ≤5 nearMatches. A tie at the top score → `ambiguous` unless `first`. `stable` = testid, else accessible name, else selector (flows depend on it).
- Visibility: `checkVisibility({checkOpacity: true, checkVisibilityCSS: true})` with the zero-rect test; never `getComputedStyle` on ancestors. Elements under `inert` or an `aria-hidden="true"` ancestor are excluded from els and from text resolution.
- els: open shadow roots walked; same-origin iframes included (El.frame); an open `dialog[open]` / `[aria-modal="true"]` lists first with `dialog: true` and drops the background; `--clickables` adds `cursor:pointer` elements with no role. Names from aria-label/labelledby/label, else `textContent` (not innerText) squashed to 80. Output ordered: dialog, then viewport top-to-bottom, then the rest; stop scanning once the budget is full and the viewport set is complete. `diff` keeps the previous scan per tab (ref → role+name+state signature).
- `cssPath` is no longer computed (identity refs replace it). Remove `RefEntry.cssPath` usage; send the lead the protocol lines for RefEntry if its shape changes.

**Owns.** `src/daemon/resolve.ts`, `src/daemon/distill.ts`, `tests/resolve.test.ts` (headless Playwright page driven directly via playwright-core, no daemon; covers Save vs Save draft, hidden test-id twin, `2` as text, shadow button, iframe button, modal scoping, ambiguous tie, stale after removal, 6,000-element scan time).

**Hand-off to core.** You don't edit session.ts. When resolve.ts is ready, send the lead the exact replacement for session.ts's resolveTarget/els/nearMatches/register wiring; core applies it.

**Done when.** tsc silent; `bun test tests/resolve.test.ts` passes; 6,000-element els under 150 ms (was 1,440); report numbers.

## agentkit: opus-high (phase 2)

**Goal.** `bx agent` on current models, honest about cost, with a benchmark that decides the escalation ladder, and fewer turns per task.

**Read first.** Audit ITEMS G1–G6; `G:\code\bx\src\agent\driver.ts`, `G:\code\bx\src\agent\tools.ts`, `G:\code\bx\src\bench\bench.ts`; `C:\Users\dested\.bx\agent-log.jsonl` for history.

**Decisions already made.**
- G1: `MODEL_IDS` = `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`. Prices per MTok input/output: haiku 0.10/0.50 (prompts ≤100K; 0.50/2.50 above), sonnet 2/10, opus 4/20; cache reads at 10% of input. Move them to `src/agent/pricing.ts` with `PRICES_CHECKED = "2026-10-12"`. Update the `--opus` help/comment text ("Opus 4.8" → "Opus 5.5") by sending the lead the cli.ts lines.
- G2: `bun src/bench/bench.ts --agent-suite` runs ~12 fixed tasks against the fixture (login, add task, filter, settings toggle, game win via drive, a popup, a modal, a select) at a chosen tier, reporting pass rate, median turns, cost per tier, into `bench-agent-results.json`. Escalation changes: escalate only when the rung ended by stall detection or the model's own fail report; never after `budget`/`wall` endings. The escalation prompt carries the full action log for the tab (cap 3,000 chars, newest kept) plus a fresh els. Running the suite spends tokens: build it, run 2 tasks to prove it works, and ask the lead before a full run.
- G3: add tools `bx_scroll` ({deltaY?, target?}: wheel, or scrollIntoView on a target) and `bx_tabs` ({action: "list"|"switch"|"close", id?}); `bx_console` passes the pin. Tool descriptions mention the right tool for `bx_snapshot`/`js`/`wait`/`bash` guesses.
- G4: tools use action `then`/`delta` (show delta lines in the tool result), `els` diff after the first scan, `text` with `md` and main-content default, and `wait` conditions; `bx_wait` refuses `ms` > 1000 with a hint. These depend on core/resolver landing; build against the protocol types.
- G5: `bx agent --vision` makes `bx_snap` return an image content block (JPEG q70, max 1024 wide, optional target crop).
- G6: the lead rewrites SKILL.md numbers from your bench; send the numbers.

**Owns.** `src/agent/**`, `src/bench/**`, `bench-agent-results.json`.

**Done when.** tsc silent; `bun src/bench/bench.ts --agent-suite --tasks 2` passes on haiku; report pass/turns/cost.

## infra: opus-high (phase 2)

**Goal.** Observation knows its tab, the daemon stops churning, disk stops growing, flows isolate themselves and explain failures, and orphaned Chrome gets cleaned up.

**Read first.** Audit ITEMS O1 O2(context) O5 D1 D3 D4 F1 F2 F3 R2; `G:\code\bx\src\daemon\observe.ts`, `debug.ts`, `record.ts`, `G:\code\bx\src\flows\*`.

**Decisions already made.**
- O1: entries carry `tab` (stable page id); console/net filter to the pinned tab unless `allTabs`; unpinned human commands see all tabs (unchanged). NetEntry gets `id` (monotonic) and `resourceType`; default net shows document/xhr/fetch only, `all` shows everything. `netBody {id}`: keep a WeakRef to the Playwright Response for the last 200 entries; text bodies only, capped at TEXT_MAX_CHARS. Invalid regex → escaped literal. The RingBuffer becomes a true circular buffer. Hand core the observe-API changes it must call (send the lead the lines).
- D4: `/debug?light=1` skips per-page CDP sessions and Performance.getMetrics (pages listed with id/url only). DEBUG_VERSION stays 1.
- O5: harness routes require `?n=<nonce>` (crypto.randomUUID per recording); the harness page carries it on every fetch.
- D3: tmp-video removed in a finally; on daemon start, snaps older than `BX_SNAP_DAYS` (default 7) are deleted from `~/.bx/snaps` (only files bx named, `*.png`/`*.jpg`).
- R2/D1: new `src/daemon/orphans.ts` (node:* only): `findProfileChromes(profileDir) → {pid, cmdline}[]` via `powershell -NoProfile -Command Get-CimInstance Win32_Process -Filter "Name='chrome.exe'"` JSON; `clearProfileLocks(profileDir)` kills orphans (no live daemon for that profile) and removes `SingletonLock`/`lockfile`/`SingletonCookie`/`SingletonSocket`. New `src/maintenance.ts` (Bun side): `doctor({fix})` (orphan Chromes, stale run files, locks, oversized logs) and `gc({olderThanDays=14, caches, yes, keep})`: lists profiles with size and last use (newest mtime of `<profile>/Default/Preferences`, `<profile>/Local State` and its log); dry run unless `yes`; never `default`, never a profile with a live daemon, never one in `keep`; `caches` deletes `Default/Cache`, `Default/Code Cache`, `Default/GPUCache`, `GrShaderCache`, `ShaderCache`, `Default/Service Worker/CacheStorage` only. The lead wires `bx doctor` and `bx gc` in cli.ts.
- F1: FlowContext opens its own tab (`tabNew background`), pins every step to it, closes it in a finally; `runFlow` accepts and passes `headless`. F2: a failed step keeps the BxError (near matches printed), saves `<flow>.fail.png` and `<flow>.fail-els.txt` next to the flow. F3: synthesized password fills emit `process.env.BX_<FLOWNAME>_PASSWORD ?? ""` with the TODO kept; `expectNoConsoleErrors()` and `expectJs(expr)` on FlowContext; mutating `js` steps (any js command in the log) synthesize to `await b.js(...)`.

**Owns.** `src/daemon/observe.ts`, `src/daemon/debug.ts`, `src/daemon/record.ts` (until V1), `src/daemon/actionLog.ts`, `src/daemon/orphans.ts`, `src/maintenance.ts`, `src/flows/**`, `tests/flows.test.ts`, `tests/record.test.ts`, `tests/maintenance.test.ts`.

**Done when.** tsc silent; unit tests pass; `gc` dry run lists real profiles on this machine without deleting anything (paste the top 10); `doctor` output pasted.

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

Live tool: global bx → G:/code/bx-live (a80f037), relinked by Sal 2026-10-12.
Background jobs: none
Waiting on Sal: sample approval (after core reports)
Next: review core's sample, then spawn resolver, agentkit, infra
