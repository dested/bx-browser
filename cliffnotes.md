# bx — cliffnotes

Last updated: 2026-08-06

Purpose-built browser automation for Claude Code. A per-profile **daemon**
(runs under **Node** — not Bun; see decisions.md) holds one real Chrome via
playwright-core persistent contexts; the **CLI/flows/agent** (run under Bun)
talk to it over localhost HTTP. Everything is token-budgeted at the source.

## Directory tree

```
src/
  protocol.ts        THE contract: Cmd union, results, budgets, targets, agent types
  cli.ts             bx entry — arg parsing, dispatch, human output, exit codes
  client.ts          daemon discovery/spawn (node, detached), cmd<T>(), parseTarget
  daemon/            ⚠ Node runtime: no Bun.*, no non-erasable TS syntax
    daemon.ts        node:http server, routes (/health /cmd /shutdown /fixture /harness*)
    session.ts       browser lifecycle, target resolution, action log, ref registry
    distill.ts       els: DOM scan → numbered elements, budget-capped rendering
    observe.ts       console/net ring buffers, per-action error marks
    record.ts        recording: video relaunch cycle + harness orchestration
    harness/harness.ts  browser-side: runs video-to-prompt distill() in-page
  flows/
    api.ts           flow() + FlowContext (what "bx/flow" resolves to)
    runner.ts        bx run: import flow file, per-step log, PASS/FAIL
    synthesize.ts    action log → flow file (replay-stable targets, no refs)
  agent/
    tools.ts         bx verbs as Agent SDK MCP tools (text in, text out)
    driver.ts        runAgent: Haiku → one-shot Sonnet escalation, usage, --save
  bench/bench.ts     bun run bench [--agent] → bench-results.json
fixtures/app/        "TaskBox" test app served by the daemon at /fixture
flows/examples/      canonical user-facing flow examples
skill/SKILL.md       the Claude Code skill (copy to ~/.claude/skills/bx)
scripts/build-harness.ts  Bun.build bundle of harness.ts (+ self-heals dep dist)
tests/smoke.test.ts  15-test live suite (bun test), profile "bxtest"
tests/flows.test.ts  synthesis + bx/flow-alias unit tests (no browser)
site/                bx.dested.com landing (Vite+React+Tailwind, self-contained)
Dockerfile, drydock.yaml, .github/  DRYDOCK-MANAGED (portal regenerates — don't hand-edit)
```

## Concept → file

| Want to change… | Edit |
| --- | --- |
| A command's wire shape / add a verb | protocol.ts, then session.ts (impl), cli.ts (parse+print), skill/SKILL.md |
| Element list contents/format | daemon/distill.ts |
| Target matching order | daemon/session.ts resolveTarget + protocol.ts comment |
| Output budgets | protocol.ts BUDGET |
| Agent behavior/system prompt | agent/driver.ts |
| Flow verbs | flows/api.ts (+ synthesize.ts mapping) |
| Recording/distill package | daemon/record.ts + daemon/harness/harness.ts |

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
- Refs go stale on navigation and els scans — by design, and per-tab: each page
  has its own registry/generation (`refsFor(page)`). Flows/synthesis never use
  refs. Commands honor the optional `tab` pin (stable page id); every agent run
  is pinned to its own tab — that is the concurrency guarantee.
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
- `video-to-prompt` (git dep) ships no dist; scripts/build-harness.ts builds it
  in place on demand. Durable fix = `prepare` script in that repo (user's).
- Recording relaunches the browser context twice (video is a context-creation
  option); open tabs are restored to the active URL only.
- Recording packages ship the video twice (raw.webm + byte-identical
  rec-01/walkthrough.webm) — accepted for v1: report.md references the latter,
  CLI/docs the former. Local disk only; recordings/ is gitignored.
- expect returns pass:false as ok:true data — only the CLI turns it into exit 1.
- One daemon per profile; ~/.bx/run/<profile>.json is the discovery file.

## Routes / URLs

- Daemon: 127.0.0.1:<random port> — /health, /cmd (token), /shutdown (token),
  /fixture/* (TaskBox), /harness* (recording distill page).
- Fixture views: #/login (demo@taskbox.test / hunter2), #/tasks, #/settings.

## Status

- v1 complete: verbs, flows, agent (Haiku→Sonnet), recording+distill, bench,
  skill. 10/10 smoke; recording e2e-verified (full package in 3.4s).
- v2 planned: playwright-crx bridge extension for daily-driver Chrome profiles
  (see decisions.md) and `bx watch`.
