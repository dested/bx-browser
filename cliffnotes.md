# bx — cliffnotes

Last updated: 2026-10-12

Purpose-built browser automation for Claude Code. A per-profile **daemon**
(runs under **Node** — not Bun; see decisions.md) holds one real Chrome via
playwright-core persistent contexts; the **CLI/flows/agent** (run under Bun)
talk to it over localhost HTTP. Everything is token-budgeted at the source.

## Directory tree

```
src/
  protocol.ts        THE contract: Cmd union, results, budgets, targets, agent types
  constants.ts       dirs, headers, DEFAULT_DEADLINE_MS — zod-free so the CLI imports it cheaply
  cli.ts             bx entry: process concerns only (stdin, batch loop, timing) + the
                     CLI-only verbs (run agent install-skill doctor gc profiles stop help)
  client.ts          daemon discovery/spawn (node, detached), cmd<T>() fast path;
                     re-exports parseTarget/formatAction/CliError from src/argv
  script.ts          batch splitting: splitScript / splitWords (shell-style quoting)
  argv/              ⚠ shared with the daemon (Node type stripping: node:* only, no Bun.*)
    parse.ts         argv → Globals (+ MSYS repair, LOCAL_VERBS, deadlineFor, client tag)
    verbs.ts         every daemon verb: args → Cmd → result → stdout/stderr/exit (VerbIO)
    serve.ts         daemon POST /argv: whole command line in, CLI bytes out, or {fallback}
    format.ts        human renderers (actions, els, status, console/net, tabs)
    target.ts        parseTarget; envelope.ts response check; usage.ts USAGE; errors.ts CliError
  maintenance.ts     bx doctor / bx gc (Bun side; dry run unless --fix / --yes; never follows links)
  daemon/            ⚠ Node runtime: no Bun.*, no non-erasable TS syntax
    daemon.ts        node:http server, routes (/health /cmd /debug* /shutdown /fixture /harness*)
    session.ts       browser lifecycle + self-heal relaunch, every command, adaptive settle,
                     action deltas, active tab by identity, step() labels for deadlines
    resolve.ts       target resolution: identity refs (in-page window.__bx), one ranked pass,
                     ambiguous ties, visible-only; scanEls for els/open/then
    serialize.ts     js: statements-or-expression wrapping + in-page JSON serializer
    orphans.ts       orphan Chrome per profile, profile-lock clearing, snap pruning
    actionLog.ts     the action log, capped at the newest 1000 entries; absolute indexes, held during a recording
    debug.ts         /debug: Journal of every /cmd (in flight, last 200, totals, clients), process + loop counters, gc, heap snapshot
    hideWindows.ts   forces windowsHide on every child_process.spawn (imported first; stops ffmpeg console windows)
    distill.ts       els in-page scan: shadow DOM, same-origin iframes, modals, --diff, --clickables
    observe.ts       console/net circular buffers tagged by tab, net ids + netBody, per-action error marks
    osPassword.ts    pre-launch seed of Chrome's OS blank-password cache (stops failed Windows logons)
    record.ts        recording V1: start/stop/mark/save/status/distill, ring buffer, follow,
                     package (video.webm, transcript.txt, recording.json), background distill
    screencast.ts    CDP Page.startScreencast per tab → paced frames → our own ffmpeg (VP8)
    harness/harness.ts  browser-side: runs video-to-prompt distill() in-page
  flows/
    api.ts           flow() + FlowContext (what "bx/flow" resolves to)
    runner.ts        bx run: import flow file, per-step log, PASS/FAIL
    synthesize.ts    action log → flow file (replay-stable targets, no refs)
  agent/
    tools.ts         bx verbs as Agent SDK MCP tools (text in, text out)
    driver.ts        runAgent: haiku→sonnet(→opus opt-in) ladder, escalates only on a
                     fail report or stall; governance (--budget/--max-wall/stall), --vision
    pricing.ts       model ids + dated price table (est=$); the SDK's own table lags
  bench/bench.ts     bun run bench [--agent | --agent-suite] → bench-results.json
  bench/agentSuite.ts  12 hidden-checked agent tasks → bench-agent-results.json
  bench/pages/       bench-only pages (modal, select, popup, filter, scroll, help)
fixtures/app/        "TaskBox" test app served by the daemon at /fixture
flows/examples/      canonical user-facing flow examples
skill/SKILL.md       the Claude Code skill (installed via `bx install-skill`)
scripts/build-harness.ts  Bun.build bundle of harness.ts (+ self-heals dep dist)
scripts/build-frontdoor.ts  dotnet publish → dist/bx.exe (no build servers: no console windows)
dotnet/bx/           bx.exe: NativeAOT front door (Program.cs). Posts argv to /argv;
                     runs `bun src/cli.ts` for LOCAL_VERBS, no daemon, or {fallback}
tests/smoke.test.ts  live daemon suite (bun test), profile "bxtest"
tests/flows.test.ts  synthesis + bx/flow-alias unit tests (no browser)
tests/record.test.ts recording unit tests; BX_RECORD_LIVE=<p> adds live start/mark/save/follow/mp4
tests/screencast.test.ts  frame pacing, ring caps (no browser)
tests/argv.test.ts   argv core unit tests; BX_PARITY_PROFILE=<p> adds live bx.exe vs bun parity
tests/actionLog.test.ts  action-log cap: absolute indexes across trims, recording hold (no browser)
tests/resolve.test.ts    resolver scenarios in a real headless Chrome (re-runs itself under Node)
tests/serialize.test.ts  js wrapping + serializer (no browser)
tests/observe.test.ts    ring wrap, tab filter, net entry lifecycle (no browser)
tests/maintenance.test.ts  doctor/gc incl. junction safety (no browser)
tests/script.test.ts, tests/target.test.ts  batch splitting, parseTarget (no browser)
site/                bx.dested.com landing — plain "no-slop" HTML: App.tsx is one
                     self-contained semantic doc + ~40-line index.css (no Tailwind,
                     no demos). Vite+React shell only.
Dockerfile, drydock.yaml, .github/  DRYDOCK-MANAGED (portal regenerates — don't hand-edit)
```

## Concept → file

| Want to change… | Edit |
| --- | --- |
| A command's wire shape / add a verb | protocol.ts, then session.ts (impl), cli.ts (parse+print), skill/SKILL.md |
| Element list contents/format | daemon/distill.ts |
| Target matching order | daemon/resolve.ts + the Targets comment in protocol.ts |
| Post-action settle / deltas | daemon/session.ts settle(), runAction |
| Cleanup (orphans, locks, disk) | daemon/orphans.ts, maintenance.ts |
| A verb's flags, Cmd mapping or human output | argv/verbs.ts (+ format.ts); the CLI and bx.exe both pick it up |
| Which verbs bx.exe hands to bun | LOCAL_VERBS in argv/parse.ts AND LocalVerbs in dotnet/bx/Program.cs |
| Agent prices / model ids | agent/pricing.ts (bump PRICES_CHECKED) |
| Output budgets | protocol.ts BUDGET |
| Agent behavior/system prompt | agent/driver.ts |
| Flow verbs | flows/api.ts (+ synthesize.ts mapping) |
| Recording/distill package | daemon/record.ts + daemon/harness/harness.ts |
| What a monitor sees (/debug payload) | protocol.ts "Debug surface" types, daemon/debug.ts collectDebug, session.ts debugInfo |

## Runtime split (the #1 gotcha)

- `src/daemon/**` runs under **Node 22** via type stripping: node:* APIs only,
  no `Bun.*`, no enums/namespaces/parameter properties. Spawned detached via
  node:child_process (Bun.spawn children die with the parent on Windows).
- Everything else runs under Bun. scripts/build-harness.ts uses Bun.build; the
  daemon shells out to it rather than importing it.

## Gotchas

- `cmd<T>` trusts the daemon's payload shape — compile-time contract only. If a
  session.ts return shape changes, agent/tools.ts and cli.ts break at runtime
  with no tsc error. Change protocol.ts first, then grep call sites.
- Refs are element identities (daemon/resolve.ts, in-page `window.__bx`): they
  survive els scans and go stale only when the element leaves the page; numbers
  grow per tab and are never reused. Resolution marks the winner
  `data-bx-ref="<id>"` (visible in the DOM; the 16 newest marks are kept per
  document). Flows/synthesis never use refs. Commands honor the optional `tab`
  pin (stable page id); every agent run is pinned to its own tab — that is the
  concurrency guarantee. A pinned console/net sees only its own tab.
- The active tab is held by Page identity, not index: a popup becomes active
  only when the active tab opened it; anything else opens in the background and
  the action's delta reports `newTab`.
- Every command runs under a daemon deadline (header `x-bx-deadline-ms`, default
  10 s, raised to timeoutMs + 5 s). A busy page answers `deadline … during <step>`
  instead of hanging; the abandoned work's result is discarded.
- The CLI posts straight to the run file's port and only spawns a daemon when
  the connection is refused — a request that reached a daemon is never resent.
- Verb parsing/rendering lives in src/argv/ and also runs inside the daemon
  (/argv for bx.exe). Keep it Node-safe; stdin reading stays in cli.ts. bx.exe
  output must stay byte-identical to `bun src/cli.ts`: a new served verb goes
  through runVerb, then `bun run build:frontdoor` and
  `BX_PARITY_PROFILE=<p> bun test tests/argv.test.ts`.
- bx.exe falls back to bun only when nothing ran (no run file, refused,
  {fallback}, 400/401/404). /argv's --json "ms" is daemon time only.
- ⚠ Nothing bx or its scripts spawn may open a window: windowsHide (Node/Bun),
  CreateNoWindow (.NET), no shell:true / cmd /c / start; dotnet builds only via
  scripts/build-frontdoor.ts (leftover MSBuild/compiler servers opened consoles).
- A dead browser is relaunched on the next command (`relaunched: true`,
  `status.relaunches`); its old tab ids answer `no_page … lost`.
- New session command handlers: `runAction(cmd, cmd.tab, perform)` +
  `pageFor(cmd.tab)` — never `ensurePage()` directly.
- `bx run`'s "bx/flow" alias rewrites the ENTRY flow file only (Bun onLoad
  hook); a helper module importing "bx/flow" won't resolve. Flows stay
  single-file.
- Git Bash mangles `/`-leading args (MSYS path conversion); cli.ts repairs
  exact-EXEPATH prefixes in main(). Belt-and-braces: MSYS_NO_PATHCONV=1.
- Rare under load: Chrome accepts a click (Playwright reports success) but no
  DOM event fires; vanishes on re-run. Re-run a burst of click-flavored smoke
  failures before believing them.
- `click` is Playwright `locator.click()` — a **trusted** CDP click
  (`isTrusted=true`), NOT a synthetic `dispatchEvent`/`el.click()` (the only
  synthetic dispatch is the pointer-drag helper at session.ts ~786, which `click`
  never touches). It drives React delegation and SPA/Next `<Link>` routers exactly
  like a human click — proven against a Link-mimic fixture (delegated onClick
  fired, preventDefault ran, history route happened). So "bx doesn't follow an
  in-app link, a real click does" is app/timing-specific (popover unmounting the
  anchor on mousedown; or state read before the async client transition settled),
  never a harness synthetic-click limitation. Verify routes with `expect url`/
  `expect text` (they retry), not a bare `js location.pathname` right after.
- `video-to-prompt` (git dep) ships no dist; scripts/build-harness.ts builds it
  in place on demand. Durable fix = `prepare` script in that repo (user's).
- Recording never relaunches Chrome: it is a CDP screencast of one tab (or the
  active tab with `--follow`) piped into our own ffmpeg. Every frame is captured
  (everyNthFrame 2 dropped single repaints); pacing to 25 fps happens downstream.
  A still page sends no frames, so start races a screenshot against the first.
  Never run Playwright's recordVideo or page.screencast on a recorded page.
- Distill runs in the background after `record stop` (status lists it under
  `distilling`); `--distill` waits. Report wording says "action log", never
  speech. Packages are local only; recordings/ is gitignored.
- expect returns pass:false as ok:true data — only the CLI turns it into exit 1.
- One daemon per profile; ~/.bx/run/<profile>.json is the discovery file.
- Daemons exit after `BX_IDLE_MINUTES` (default 15) with no /cmd and no active
  recording or background distill. `bx stop --all` sweeps every daemon and clears stale run files.
- ⚠ Every Chrome launch must be preceded by `seedOsPasswordCheck(profileDir)`.
  On a cold profile, Chrome checks for a blank Windows password with a real
  (failed) interactive logon, and a burst of those locks the Windows account.
  Any new launch path must call it.
- `bx tab close --all` reopens one blank tab after closing every page — closing
  the last page of a persistent context can take the browser (and the daemon's
  usable context) down with it, so the blank keeps the context alive. Don't drop
  it. `--others` keeps the active tab; plain `tab close` is unchanged. Agent tabs
  are auto-closed by the driver's finally (tools.ts `pin.close()`), not by these.
- `/debug` has outside consumers: destedtui's bx screen (`destedtui --bx`,
  `bxtop`, G:\code\destedtui src/lib/bx.ts) parses it with its own zod mirror,
  and sal-widgets' Fleet row (G:\code\sal-widgets\src\SalWidgets.Core\Health\BxWatch.cs)
  reads `data.pages.length` every 15 s plus the run files' pid/port/token.
  Keep changes additive (new optional fields are fine; renames and removals
  break it) and bump `DEBUG_VERSION` for a breaking change. Reading /debug must
  never touch `lastActivity`, or a monitor keeps every daemon alive forever.
- Every CLI request carries `x-bx-client` (Claude session id, cwd, pid, verb)
  so /debug can say who drives a daemon. It's informational: the daemon never
  rejects a request over it.
- Daemons spawn with `--expose-gc` (client.ts) so /debug/gc can force a full
  collection; a daemon from before 2026-10-08 reports `gcExposed: false`, and
  an older one 404s /debug entirely ("old daemon" in the monitor).
- The action log (`session.actions`, daemon/actionLog.ts) keeps the newest
  1000 entries. Readers hold ABSOLUTE indexes (`nextIndex`, `entry.index`):
  read through `actions.since(i)`, never by array position, or a trimmed log
  hands back the wrong entries. A recording calls `holdFrom(start)` so its
  transcript can't be trimmed mid-take; anything else that needs a long
  unbroken stretch must hold it the same way.

## Routes / URLs

- Daemon: 127.0.0.1:<random port> — /health, /cmd (token), /shutdown (token),
  /debug, /debug/gc, /debug/heapsnapshot (token; heap snapshots land in
  ~/.bx/heaps/), /fixture/* (TaskBox), /harness* (recording distill page).
- Fixture views: #/login (demo@taskbox.test / hunter2), #/tasks, #/settings,
  #/game (canvas mini-game: window.__game state, keys hook, pointer shelf).

## Status

- v1 complete: verbs (incl. canvas mouse/drag/key/wheel + `drive` in-page
  controller), flows, agent (haiku→sonnet→opus opt-in, budget/wall/stall
  governance, --url/--enter/--win entry+win recipe), recording+distill,
  bench, skill, bx.dested.com. Real-time-game driving live-proven (SceneBeans
  Round 4 win $0.16; fixture-game agent win on Haiku $0.037).
- npm: publishes as `bx-browser` (bin `bx`); `bx install-skill` copies
  skill/SKILL.md to ~/.claude/skills/bx. Site build snapshots the skill via
  site/scripts/gen-skill.ts → src/data/skill-source.ts (SkillModal shows it).
- v2 planned: playwright-crx bridge extension for daily-driver Chrome profiles
  (see decisions.md) and `bx watch`.
