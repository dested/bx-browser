# Updates

## 2026-08-07 — Round 5 verification: shipped game-driving surface all works
Re-tested the shipped --url/--enter/--win, bx drive, estimator rebase, and
tab-scoped evidence against SceneBeans. All green. Bee Dodge via --enter/--win:
PASS Haiku 15 turns $0.06 (entry runs before turn 1, whole budget goes to the
controller — the R4 entry-discovery sink that made the same task a $0.60 failure
is gone; --win verified by the driver, est==metered). Balloon Flight agent: PASS
Haiku 38 turns $0.11 — agent dumped the hook's input shape, found aDown, and
DISCOVERED it's edge-triggered, pulsing the flap ~every 8 frames to gain altitude
and reach the flag (closes the R4b structural miss). Picnic Panic via bx drive
hand-iteration: WON in 2 iterations, ZERO model tokens each — a 5s idle-watch
found the real hazard is one chasing fox (not the 5 stationary props); iter2
avoid-only-fox → won 8/8, 2 hearts. bx drive verified end-to-end (install +
daemon poll + timeout exit1 + in-place replace). Estimator: est==metered on
completed runs ($0.06/$0.11), est≥metered on ended=budget (includes aborted rung)
— the ~3x "pessimism" was the metering artifact, now both cost=/est= printed.
Concurrency: two concurrent fails printed DIFFERENT tails; operator tab survived.
New doc micro-finding: edge-triggered buttons must be PULSED not held — worth one
line in game-driving guidance. Round 5 appended to
plans/2026-08-07-winning-games-and-claude-chrome-parity.md. Flows: r5-beedodge,
r5-balloon.

## 2026-08-07 — Round-4 response: bx drive, --enter/--win, estimator truth, evidence scoping
New `drive` primitive end to end (protocol cmd -> daemon poll loop -> CLI verb
-> flow api/synthesis -> bx_drive agent tool): installs a JS controller once,
polls a predicate daemon-side until truthy/timeout — zero model tokens during
play; re-issuing replaces the controller in place. Agent gains --url (pinned
tab opens there), --enter <js> (entry recipe runs before turn 1, re-runs per
escalation rung — kills the entry-discovery cost sink) and --win <expr>
(handed to the model AND driver-verified before a pass is accepted; falsy
predicate flips pass->fail). Estimator: cache writes now billed (1.25x), est
rebased to metered cost at every rung boundary, trailer prints cost=$ AND
est=$ (est includes aborted rungs, which metered cannot). Fail evidence + flow
synthesis now scoped to the run's own tab (ActionLogEntry.tab) — no more
cross-contamination under concurrency. SYSTEM prompt: real-time-game paragraph
(per-key play cannot win; inspect full input schema incl. buttons; roles from
defId counts). Site: new "It won a video game" section. Live-proven on the
fixture game: hand bx drive satisfied in 2.5s/9 polls; agent with
--url/--enter/--win PASSED ON HAIKU — 14 turns, $0.037, est $0.04, driver
win-verify line in evidence. tsc clean, 25/25 tests.
Touched: src/protocol.ts, src/daemon/{session,daemon}.ts, src/cli.ts,
src/flows/{api,synthesize}.ts, src/agent/{driver,tools}.ts, tests/, skill/
(synced), README.md, site/

## 2026-08-07 — Round 4b folded into the parity report: mechanism universal, winning controller per-game
Updated plans/2026-08-07-winning-games-and-claude-chrome-parity.md with the
three-game generalization evidence: Bee Dodge WON (agent $0.16/72 turns + by
hand), Picnic Panic LOST to hazard density (mechanism steered perfectly,
controller too weak — tuning problem), Balloon Flight NOT WON structurally
(joystick-only controller flew x=200→3950 flawlessly, all hearts, but lift is a
flap BUTTON — heroY pinned 732 vs flagY 560; override returns Partial<GameInput>
incl. buttons). New section "Round 4b" with the 3-game table; `bx drive` spec
tightened (full input schema + inspect hook return shape first + zero-token
controller-replace/re-poll iteration loop); app-side note now demands win signal
AND full input schema; TL;DR/Bottom line sharpened.

## 2026-08-07 — Round 4: bx WON a live canvas game (vs Claude Chrome)
The agent won SceneBeans "Bee Dodge" ($0.16, 72 turns): opened via
__studio.openProject, inferred hero/flowers/bees from getInstances() defId
counts, AUTHORED a seek-and-avoid controller, injected it via the app's per-frame
window.__play.override hook, and polled runner.status until 'won'. This is the
pattern no screenshot agent (Claude Chrome/computer-use) can execute — read state
+ inject controller + poll a deterministic win signal. Honest-keys play (no hook)
FAILED on budget: turn-based per-key steering can't keep 60fps pace — the
fundamental wall for any turn-based agent on real-time games. Critical cost
finding: same task phrased "find Bee Dodge and win" ALSO failed on budget —
entry DISCOVERY, not gameplay, ate the whole budget ($0.60 fail vs $0.16 win,
only difference = exact entry recipe). Top asks: (1) --enter <js> / --win <expr>
inputs (or a `bx drive --install --until` primitive that installs+polls a
controller in-page, zero model turns) to kill entry-discovery cost; (2) document
the in-page-controller pattern as THE way to drive real-time games; (3) still-open
estimator ~3x pessimism (est $0.60 vs metered $0.21, x4 more data points) + the
concurrency fail-evidence contamination. Full competitive write-up:
plans/2026-08-07-winning-games-and-claude-chrome-parity.md. Flow saved:
canvas-win-controller2.

## 2026-08-07 — Round 3 test results (SceneBeans canvas): gamedev WORKS
Tester run against the Round-2-response build. Canvas gamedev crossed from
"falls apart" to "works cheaply". PASSes: wayfinding via app-nav handle (opened
editor through __studio.getState().openProject — Haiku, $0.05) and pointer-drag
(solo: shelf→stage in pointer mode, scene instances 30→31 verified via bx_js —
Haiku, $0.09, --opus not even needed). Budget ceiling verified (failing runs
abort ended=budget, no more $1.65 runaways); heartbeat + flow-save-on-pass work.
BUGS to fix: (1) fail-report "last actions" evidence is cross-contaminated under
concurrency — pulled from the shared action log, not the run's own tab (two
concurrent runs printed identical tails); scope to the attempt's tab. (2) budget
estimator still ~2-3x pessimistic (aborts est $0.30 vs metered $0.12 — the 10%
cache-read pricing note notwithstanding, it's cutting runs ~3x early). (3) "win
a live game" still open: agent reached play mode but burnt budget hunting a win
flag — app should expose window.__play.runner.verdict and the prompt should name
it. Through-line: every PASS named the handle; cold canvas tasks still blind-
click. Full write-up in plans/2026-08-06-scenebeans-canvas-gamedev-test.md
(Round 3). Flows saved into the SceneBeans repo: canvas-nav3, canvas-drag-solo.

## 2026-08-07 — Round-2 response: cost governance + pointer drag + tab-steal fix
--budget <usd> / --max-wall <s> abort mid-rung across the WHOLE ladder with a
synthesized fail report (trailer gains ended=budget|wall|stall|turns|error;
est spend from per-tier pricing, cache reads at 10%); stall detection (<=3
distinct calls in a window of 8 = end rung early, escalate); heartbeat line
every 10 turns (off under --json); escalations open a fresh tab AT the prior
rung's last URL (UrlTracker) instead of about:blank; wayfinding system prompt
(map window.__* first, prefer store actions/deep-links over pixel guessing).
drag --pointer: press-and-settle PointerEvents (~120ms hold, capture-correct
delivery) — the real DnD discriminator is timing, not event type (see
decisions.md); --hold/--step-delay knobs carried through flows save->replay.
Agent tabs now background: never steal the operator's active tab; tabClose
re-anchors by page identity. Fixture pointer-intent shelf + 3 smoke tests.
Live-proven: budget abort at turn 1 (ended=budget), stall->escalate, heartbeat
+ escalated PASS at $0.18 under a $0.25 budget. tsc clean, 21/21 tests.
Touched: src/agent/{driver,tools}.ts, src/cli.ts, src/protocol.ts,
src/daemon/session.ts, src/flows/{api,synthesize}.ts, fixtures/, tests/,
skill/SKILL.md (synced)

## 2026-08-07 — agent debuggability + Opus tier (SceneBeans canvas shakedown)
Canvas-first app (WebGL, 0/3 tasks) exposed black-box failures: added always-on
turn transcripts (~/.bx/agent-runs/<ts>.jsonl, path in trailer), synthesized
fail reports on turn exhaustion (last actions as evidence, never bare
maxTurns), informed escalation (prior summary + last 5 actions), --max-turns
(default 40) + --verbose, agent bx_js + canvas system-prompt guidance, and
opt-in Opus 4.8 tier (--opus = final sonnet->opus rung; --model opus direct).
Skill/README updated; live-proven on fixture game (Haiku PASS $0.065).
Touched: src/agent/{driver,tools}.ts, src/cli.ts, src/protocol.ts, skill/,
README.md

RE-TEST (Round 2, same 3 SceneBeans tasks): debuggability P0 VERIFIED FIXED —
every run now ends with a synthesized fail report + transcript; diagnosed all 3
from outside. bx_js used hard (59x on the Opus build; reads
__studio.getState().project.scenes). Tasks still 0/3, but for now-visible
reasons: (A) walkable-trail home = no DOM/affordance to open a game, blind
agent can't find the node; (B) StickerShelf pointer-intent drag (touch-none +
mostly-vertical-pull) no-ops under Playwright mouse.* drag; (C) cost inverted —
3-rung ladder to exhaustion = $0.72-$1.65/run (build 10.7min). New P0 = cost
governance (--budget + stall-detected early escalation) + a pointer-event drag
mode + canvas *wayfinding* guidance (prefer app-nav handles over blind clicks).
Full write-up + Round 3 bar in plans/2026-08-06-scenebeans-canvas-gamedev-test.md.

## 2026-08-06 — shakedown fixes, tab isolation, canvas verbs, landing site
Real-app shakedown (Coterie) drove the roadmap: fixed --save flows (passing
expects now logged + synthesized; bx run resolves "bx/flow" anywhere via
entry-file onLoad rewrite — Bun onResolve can't see bare specifiers), MSYS
path-mangling auto-repair, --help short-circuit, --json ms + BX_TIMING=1.
Made agent concurrency a real guarantee: stable tab ids, per-page ref
registries, every agent pinned to its own tab (closed in finally). Added
canvas/gamedev verbs (mouse/drag/key/wheel, element-relative via --in) +
fixture #/game + 3 smoke tests (18/18 green). Rewrote SKILL.md agent-first.
Built site/ (Vite+React+Tailwind) — interactive terminal, transcript race
with live app screens, no-magic artifacts, agent-mode showcase — and DEPLOYED
to https://bx.dested.com via drydock (project "bx", static/xs, rootDir site;
drydock owns root Dockerfile/drydock.yaml/.github). bx linked globally +
skill installed.
Touched: src/** (protocol, session, daemon, cli, flows, agent), fixtures/,
tests/, skill/, site/**, README.md

## 2026-08-06 — recording pipeline + comparison blog post
Landed record start/stop: relaunch-cycle video capture, in-browser
video-to-prompt distill via /harness routes, action log grafted as timed
transcript (passwords redacted). E2e verified on fixture: full package
(raw.webm + keyframes + contact sheet + report.md) in 3.4s at record stop.
Blog post drafted+committed in casualdeveloper.net (not deployed).
Touched: src/daemon/record.ts, src/daemon/harness/harness.ts, session.ts,
daemon.ts, scripts/build-harness.ts
Per plans/2026-08-06-bx-architecture.md (now done).

## 2026-08-06 — build bx v1 (fable-opus, 5 Opus agents)
Full v1: node daemon + distiller + observers, CLI + flows + synthesis, Agent
SDK driver (Haiku→Sonnet), bench + 10-test smoke suite, skill + docs + fixture.
Fixed: daemon must run under Node (Bun CDP pipe broken on Windows) and be
spawned detached via node:child_process. Measured: 730ms cold start, els 61×
cheaper than raw DOM, flow replay 0 tokens, Haiku agent pass $0.037.
Touched: src/**, fixtures/, flows/, skill/, tests/, scripts/ (initial build)
Per plans/2026-08-06-bx-architecture.md (recording + blog still open).
