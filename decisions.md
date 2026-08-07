# Decisions

Newest first. Append-only; supersede, never delete.

## 2026-08-07 — npm package name is `bx-browser`; the bin and brand stay `bx`

**Why:** `bx` is squatted on npm. `bx-browser` keeps the brand first
(`bun add -g bx-browser`, `bunx bx-browser`) and the bin map still installs a
`bx` executable, so nothing user-facing changes. The `bx/flow` import alias in
flow files survives the rename via a tsconfig `paths` mapping (the runtime
alias was always the runner's onLoad rewrite, never package self-reference).
Skill installation is a first-class CLI verb — `bx install-skill` copies the
packaged skill to `~/.claude/skills/bx` cross-platform — because the two-line
install (`bun add -g bx-browser && bx install-skill`) is identical on macOS,
Linux, and Windows, and the website leans on that.
**Rejected:** `claude-bx` (trademark-adjacent), `browx`/`usebx` (renames the
brand), an npm postinstall hook for the skill (silent writes into ~/.claude
are hostile; an explicit verb is one command and auditable).

## 2026-08-07 — Real-time games are driven by in-page controllers, not model turns

**Why:** Round 4 proved a turn-based agent structurally cannot win a 60fps
game (read→decide→keypress is seconds per decision), while an agent-authored
controller injected through the app's per-frame hook won for $0.16 — and the
whole gap between that win and a $0.60 failure was entry discovery, not
gameplay. So: `drive` is a first-class primitive (install once, poll a
predicate daemon-side, replace-in-place to iterate at zero model cost) and
`bx agent` takes the entry recipe (--url/--enter) and win signal (--win) as
inputs instead of budget-burning discovery. --win is driver-verified before a
pass is accepted — the model's claim is not the evidence, the predicate is.
**Rejected:** letting the agent hand-poll via bx_js loops (a turn per poll,
the exact cost sink drive removes); trusting a model-reported pass when a
machine-checkable predicate exists.

## 2026-08-07 — Agent trailer reports metered AND estimated cost, rebased per rung

**Why:** "estimator ~3× pessimistic" was mostly a metering gap: an aborted
rung's spend never gets an SDK result message, so the trailer's metered cost
under-reported exactly when --budget fired. Est is now rebased to metered
truth at every completed rung boundary (drift cannot compound), cache writes
are billed (1.25×), and the trailer prints both `cost=$` and `est=$` — est is
the number to trust on aborted runs. Live check: est $0.04 vs metered $0.037.
**Rejected:** trusting per-message estimates across a whole ladder (drifts),
hiding est once metered exists (conflates the two on aborted runs).

## 2026-08-07 — Pointer drag mode = press-and-settle timing, not event type

**Why:** The SceneBeans Round 2 hypothesis ("touch-none DnD never sees
Playwright mouse events") turned out false — Chrome synthesizes real
PointerEvents from CDP mouse input. The actual failure mechanism: Playwright's
drag reaches its first move ~30ms after mousedown, which pointer-intent DnD
reads as a flick/scroll, and capture delivery matters. `drag --pointer`
dispatches synthetic PointerEvents with a default 120ms hold-then-pull,
per-step delays, and all moves/up delivered to the pointerdown element
(emulating setPointerCapture). Verified: pointer mode arms a
press-and-settle shelf every run; default mouse drag never does.
**Rejected:** trying to slow Playwright's mouse drag with waits (no capture
semantics, and mouse-mode timing under load is not a contract).

## 2026-08-06 — Concurrency = tab pinning with per-page ref registries

**Why:** A real-app shakedown ran 5 concurrent `bx agent`s and inferred an
isolation guarantee that didn't exist — all commands hit the single active
tab; results stayed coherent only because Haiku's open→read pairs are
adjacent. Made it real: stable per-page ids, optional `tab` field on
page-scoped commands, per-page ref registries/generations; every agent run
creates and pins its own tab and closes it on exit. Unpinned commands (the
human CLI) keep active-tab semantics.
**Rejected:** serializing agent runs (kills the fan-out value); documenting
the race as a caveat (a guarantee people rely on must be enforced).

## 2026-08-06 — "bx/flow" resolves via an entry-file onLoad rewrite

**Why:** Flow files import "bx/flow", unresolvable outside this repo. The
obvious fix — Bun `onResolve` aliasing the bare specifier — does not work:
on Bun 1.3.10 runtime plugins never receive bare specifiers (verified with a
catch-all filter). Instead `bx run` registers an onLoad hook filtered to the
exact flow file path and rewrites the quoted specifier to src/flows/api.ts.
Scoped per-file because onLoad must return contents for everything it
matches. Limitation: helper modules importing "bx/flow" are not aliased —
flows are single-file by design.
**Rejected:** onResolve (broken for bare specifiers), emitting absolute
import paths at synthesis time (machine-specific artifacts).

## 2026-08-06 — Action-log transcript is grafted post-distill, not a Transcriber

**Why:** video-to-prompt's `distill()` only invokes a `transcriber` when the
video has an audio track; Playwright recordings are silent, so a fake
Transcriber injecting the action log would simply never run. Instead the
harness runs distill without one, then rewrites `take.meta.transcript` and
re-derives transcript.txt / recording.json / report.md / MANIFEST.txt via the
library's exported builders (`buildReport` et al. exist for exactly this).
**Rejected:** synthesizing a silent audio track to trigger the transcriber
(wasteful, fragile); patching video-to-prompt (user's repo, and the builder
exports already cover it).

## 2026-08-06 — Daemon runs under Node; everything else under Bun

**Why:** Playwright's default CDP pipe transport uses stdio fds 3/4, which Bun
on Windows does not wire up — Chrome launches but the handshake times out
(180s); under Node it connects in ~400ms. The websocket fallback also fails
under Bun (`node:http` never emits `upgrade` to Playwright's `ws`). The daemon
(src/daemon/**) is therefore runtime-neutral (node:http/node:fs, zero `Bun.*`),
spawned as `node daemon.ts` — Node 22.18+ type stripping runs the .ts files
directly, no build step. Constraint: no non-erasable TS syntax in src/daemon/**
(no parameter properties, enums, namespaces). CLI, flows, agent driver, bench
stay on Bun.
**Rejected:** running the daemon under Bun (CDP pipe broken), connectOverCDP
websocket bridge under Bun (upgrade event never fires; shimming got the
handshake but no data), bundling the daemon to JS (adds a build step for no
gain).

## 2026-08-06 — Self-healing in-place build for the video-to-prompt git dep

**Why:** `github:dested/video-to-prompt` declares `main`/`types` into `dist/`
but ships only `src/` (no build on git install), so the package is unresolvable
as installed. `scripts/build-harness.ts` detects a missing dist and runs
`bun x tsc -p tsconfig.build.json --rootDir src` inside the dep before
bundling; `skipLibCheck` keeps its emitted declarations out of our strict
program. Durable fix is a `prepare` script in the video-to-prompt repo.
**Rejected:** bundling the dep's raw src into our TS program (~25 errors under
`noUncheckedIndexedAccess`), vendoring the source (drift), publishing to npm
now (user's call, separate repo).

## 2026-08-06 — video-to-prompt runs in-browser via harness page

**Why:** `dested/video-to-prompt` is browser-only by design; bx already
controls a browser, so `distill()` runs in an internal page and writes the
package via exposed bindings. bx's action log doubles as the transcript.
**Rejected:** porting it to Node (pointless), external ffmpeg pipeline
(duplicate of a tool that already exists and is battle-tested).

## 2026-08-06 — Agent SDK for the driver session

**Why:** typed tool definitions for bx verbs, persistent session (no 2–4s
`claude -p` spawn per step), mid-session model switching for the escalation
ladder, subscription auth.
**Rejected:** `claude -p` process-per-step (spawn latency), raw stream-json
(more plumbing, fewer types).

## 2026-08-06 — Two backends: managed profiles (v1) + playwright-crx bridge extension (v2)

**Why:** Chrome 136+ blocks CDP on the default user-data-dir and app-bound
encryption blocks cookie import, so real daily-driver profiles are reachable
only from inside an extension. playwright-crx gives full Playwright semantics
via `chrome.debugger`; a self-hosted sideloaded extension per profile connects
to bx's local daemon and registers by profile name (`bx --chrome work`).
Managed persistent profiles stay the default (headless, CI, no banner).
**Rejected:** CDP-attach to real profiles (blocked by Chrome), cookie import
(blocked by app-bound encryption), extension-only design (loses headless/CI).

## 2026-08-06 — Model tiers: Haiku drives, Sonnet escalates, main model judges

**Why:** distilled ~800-token DOM snapshots + a ~12-verb action space make
compilation a constrained translation task Haiku 4.5 handles; Sonnet takes
first-failure retries and indirection; visual verdicts go to the main session
as keyframes. Tier resolution is logged per task to tune with data.
**Rejected:** Sonnet-everywhere (slower, burns quota), Haiku-only (weak on
repair/judgment).

## 2026-08-06 — CLI + teaching skill, not an MCP server

**Why:** zero schema overhead (~10 tokens per Bash call vs hundreds per tool
schema), composable, output token-budgeted at the source.
**Rejected:** MCP server (schema weight, the exact failure mode of Claude in
Chrome).

## 2026-08-06 — Flows are typed TS artifacts

**Why:** tsc catches drift, flows double as regression tests, replay costs
zero model tokens.
**Rejected:** YAML (no type safety), re-driving flows with a model every run
(the Claude-in-Chrome cost model).
