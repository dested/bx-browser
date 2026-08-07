# SceneBeans canvas / gamedev shakedown — bx agent

- **Date:** 2026-08-06 (Round 1) · 2026-08-07 (Round 2 + Round 3)
- **Status:** active — Round 3 done. **Canvas gamedev now genuinely works:**
  wayfinding (via app-nav handle) and pointer-drag both PASS on Haiku for ~$0.05–
  0.09; budget ceiling + heartbeat + flow-save all verified. Remaining: a
  concurrency bug in fail-report evidence, a pessimistic budget estimator, and
  "win a real game" still unsolved. See Round 3.
- **Type:** test report
- **Tester:** Claude (Opus) driving the installed `bx` skill against SceneBeans
- **Target app:** SceneBeans Studio (`http://localhost:5183`) — a kids' game-maker.
  Home, editor, and play are **all one full-screen WebGL (three.js) canvas**.
  Minimal DOM: a handful of floating buttons; everything meaningful is drawn.
  This is the first real **canvas game** to hit the new canvas verbs (the
  2026-08-06 shakedown that added mouse/drag/key was a DOM app, Coterie).

## TL;DR

`bx agent` **falls apart completely on a canvas-first app.** 3 escalating tasks,
**0/3 passed** — all three hit `maxTurns` on Haiku, escalated, hit `maxTurns`
again on Sonnet, and **errored without ever calling `bx_report`**. The caller
gets one line — `agent run errored: Reached maximum number of turns (30)` — and
nothing else. No transcript, no evidence, no partial progress, no saved flow.
**The failure is undebuggable from the outside, which is the most urgent bug.**

## What I ran

Three `bx agent` runs, fired concurrently (concurrency itself worked — each got
its own tab, no interference), each with `--save`:

1. **Navigate → editor** (easiest): reach the Adventure Trail home, open the
   first game into its editor.
2. **Gamedev build**: in a game's editor, drag a "thing" from the bottom shelf
   onto the stage canvas, then press Play.
3. **Play → win**: enter Play mode, move with WASD/arrows + Space, reach a win.

Ground truth (I drove it by hand first): the onboarding is DOM buttons
(welcome cinematic → hero pick → name), but **once on the trail, home is a
walkable 3D diorama** — to open a game you tap a node *on the canvas* or walk the
hero to it. Editor and play are canvas too. So every task requires canvas
coordinate interaction; only the intro is DOM.

## Results

| Task | Tier (final) | Turns | Wall | Cost | Outcome |
| --- | --- | --- | --- | --- | --- |
| 1 Navigate → editor | sonnet (escalated) | 96 | 151.7s | $0.3565 | maxTurns; no report |
| 2 Drag thing → play | sonnet (escalated) | 91 | 142.9s | $0.2438 | maxTurns; no report |
| 3 Play → win | sonnet (escalated) | 96 | 159.4s | $0.2591 | maxTurns; no report |

- **0/3 passed.** Even task 1 (mostly DOM onboarding + one canvas node-tap) failed.
- Every run exhausted Haiku's 30 turns, escalated, exhausted Sonnet's 30.
- **`bx_report` never fired** → `final` fell through to "agent ended without
  reporting" and the SDK surfaced `Reached maximum number of turns (30)` instead.
- Cost per run **$0.24–$0.36**, ~10× the skill's advertised $0.02–0.06. The
  escalation doubles the burn: Sonnet re-runs the *same* DOM-only prompt from
  scratch and fails the *same* way, at Sonnet prices.
- `--save` writes only on PASS, so **no flows were produced** — nothing to replay
  or inspect afterward.

## Root cause (from reading `src/agent/driver.ts` + `src/agent/tools.ts`)

The canvas *verbs* exist and are well-built. The **agent** was never taught to
use them, and can't perceive or verify canvas state. Four compounding gaps:

### 1. The system prompt is 100% DOM-oriented (`driver.ts:34–36`)
`SYSTEM` describes only the numbered-element workflow ("Element lists show
numbered refs like `[3] button "Save"` — act on them…"). It **never mentions
canvas, coordinates, `bx_mouse`/`bx_drag`/`bx_key`, or what to do when `bx_els`
comes back nearly empty.** On a full-screen WebGL app `els` returns ~2 buttons,
so a model following this prompt has no move — it re-scans, clicks text that
isn't there, and thrashes to the turn cap. The tools are present; the *policy*
to reach for them is absent.

### 2. The agent has no `bx_js` (the biggest gap for games)
`buildTools` exposes open/els/click/fill/select/press/wait/mouse/drag/key/back/
reload/expect/text/console/snap/report. **There is no `bx_js`.** So the agent
cannot read any app-exposed state — SceneBeans hands out rich handles
(`window.__editorWorld`, `__play`, `__paper`, `__studio`, `__trail`) that make
"did the thing get added / am I in play / did I win" a one-liner — and the agent
can't touch them. The SKILL even tells the *human* driver to "pair with `bx js`
to read game state," but the agent doesn't have that tool.

### 3. The agent is perception-blind on canvas
`bx_snap` deliberately returns only a path (`tools.ts:388` — "you cannot see the
image"), correct for a text-only model. But combined with empty `els` and no
`bx_js`, on a canvas the agent has **zero** perception: no elements, no pixels,
no state. It's driving blind and can't satisfy its own "verify every outcome
with bx_expect before reporting" rule, so it never converges → loops to the cap.

### 4. maxTurns exhaustion yields no report, no evidence
`MAX_TURNS = 30` (`driver.ts:32`). When the loop ends without a `bx_report`
tool call, nothing forces a summary — the run just errors. **This is the
user-facing blocker:** a failed canvas run is a black box. You can't tell whether
it couldn't find the node, mis-estimated coordinates, or the drag didn't take.

## Recommendations (roughly in priority order)

**P0 — make failures debuggable (do this first; blocks everything else)**
1. **Stream / persist the transcript.** Emit turn-by-turn tool calls to stderr
   behind `--verbose`/`--stream`, and/or persist a per-run transcript to
   `~/.bx/agent-<ts>.jsonl` (the action log already has the raw actions — dump it
   on exit regardless of pass/fail). Right now the output file is *empty until
   the final line*, so there's no way to watch or diagnose a run.
2. **Force a report on turn exhaustion.** If the loop ends with `box.report ===
   null`, inject one final model turn ("you are out of turns — call `bx_report`
   with status=fail, what you tried, and where you got stuck"), or synthesize a
   fail report from the action log. Never surface a bare `maxTurns` error.

**P1 — make the agent competent on canvas**
3. **Canvas-aware system prompt.** Add a branch: "If `bx_els` returns few/no
   elements, the page is likely a canvas or game. Then: don't hunt for DOM refs —
   read state with `bx_js` (e.g. app-exposed `window.__*` handles), and act with
   `bx_mouse`/`bx_drag`/`bx_key` using coordinates relative to the canvas via
   `in`. `bx_snap` only saves a file; you can't see it — reason about layout
   instead." Mention that games use **held** keys (`bx_key down/up`), not `press`.
4. **Give the agent `bx_js`** (read-biased is fine). Without a way to read
   canvas/game state, the agent structurally cannot *verify* canvas outcomes, so
   it can never satisfy the verify-before-report rule on a game. This is the
   single highest-leverage fix for gamedev tasks.

**P2 — cost / escalation**
5. **Don't blind-rerun Sonnet on the identical failing prompt.** Escalation
   currently re-runs from scratch with the same DOM-only system prompt, so it
   fails the same way at 5× the price. Either raise `maxTurns` for canvas work,
   or feed the escalation the prior transcript + a "the page is a canvas, use
   coordinates" nudge so the retry is actually different.
6. **Surface the tier/turn budget as a knob** (`--max-turns`, `--tier`). 30
   turns is too few for a multi-step canvas task (navigate → node-tap → editor →
   drag → play is easily 15–25 productive actions with zero slack for retries).

**Skill doc (`skill/SKILL.md`)**
7. **Push "default to `bx agent`" harder.** Per the owner, the skill should tell
   the model to reach for `bx agent` for essentially anything task-shaped and
   only hand-drive for quick single lookups. The current "Reach for `bx agent`
   FIRST" is good but the by-hand section reads as an equal alternative — make
   the agent the strong default.
8. **Document the canvas caveat honestly** until #3/#4 land: today the agent is
   reliable on DOM apps and *not* on canvas/game verification; canvas tasks need
   app-exposed `window.__*` hooks + `bx_js` to be checkable.

## Re-test plan (after the plugin is updated)
Re-run the same three tasks unchanged. Success bar:
- Task 1 passes (reaches editor) — proves canvas node-tap + prompt guidance work.
- Task 2 reports a real pass/fail with evidence (even if the drag is hard) —
  proves debuggability + `bx_js` verification.
- Any failure returns a `bx_report` with a concrete "stuck at X" summary, never a
  bare `maxTurns` error.
- Cost per run back under ~$0.10.

## Notes
- Concurrency held up: 3 agents, 3 tabs, no cross-talk — that part of the
  2026-08-06 work is solid.
- The app's onboarding (DOM) was navigated fine in my manual ground-truth pass;
  the wall is specifically the canvas.
- Dev server: `npm run dev` in the SceneBeans repo → `:5183`. Fresh profile hits
  a one-time onboarding; completing it once (localStorage) lets agent tabs land
  on the trail directly.

---

# Round 2 — re-test after the fixes (2026-08-07)

Re-ran the **same three tasks** against the two fix commits
(`817bc44` bx_js + canvas guidance; `6f539e9` transcripts / synthesized fail
reports / informed escalation / Opus tier). This time each prompt was fed the
real SceneBeans dev handles (`window.__studio/__trail/__editorWorld/__paper`)
and the canvas selector (`in:"canvas"`), and the harder runs got a bigger
budget (`--max-turns 50/60`, `--opus` on the build task).

## Verdict: the fixes landed and WORK — but the tasks still fail

**Every P0/P1 item from Round 1 is verifiably fixed.** The reason the tasks
still fail is now *legible* — Round 1 literally could not see these walls.

| Task | Tier reached | Turns | Wall | Cost | Outcome |
| --- | --- | --- | --- | --- | --- |
| 1 Navigate → editor | sonnet (esc.) | 193 | 333s | **$0.72** | fail report + transcript; stuck in trail |
| 2 Drag thing → play | **opus** (esc.) | 301 | 640s | **$1.65** | fail report + transcript; drag never took |
| 3 Play → win | sonnet (esc.) | 218 | 374s | **$0.75** | fail report + transcript; never reached play |

### What the fixes bought us (all confirmed from the transcripts)
- **Debuggability — the P0 — is solved.** No more bare `maxTurns` error. Each
  run now ends with a synthesized fail report: `ran out of turns (N) without
  reporting`, the **last 8 actions**, and a **transcript path**
  (`~/.bx/agent-runs/<ts>.jsonl`). I diagnosed all three failures *from the
  outside* in minutes. This is the single biggest improvement.
- **`bx_js` is real and the agent leans on it hard.** The Opus build run called
  `bx_js` **59×**, including `window.__studio.getState().project.scenes` to read
  the actual game document, and the nav run **35×**. The agent can now perceive
  and (attempt to) verify canvas state. Exactly the highest-leverage Round 1 fix.
- **Canvas acting works.** Transcripts show real coordinate work: decomposed
  drags (`mouse down 170,738 → move → move → up 645,375`), `bx_key down/up` for
  held movement, `mouse click` at canvas coords. The model now *reaches for* the
  canvas verbs — the Round 1 policy gap is closed.
- **Informed escalation + Opus tier both fire** (haiku → sonnet → opus visible
  in the transcript `attempt` field).

### The deeper walls Round 1 couldn't see

**A. The walkable-trail home is a hard entry gate (killed tasks 1 & 3).**
SceneBeans' home is a *walk-the-hero-to-a-node* 3D diorama (the "Trail Wonder"
overworld). There is **no DOM affordance** — and no obvious canvas affordance —
to "open game N in the editor." Both runs thrashed here: nav concluded *"the page
is showing trail completion rather than the editor… let me reload"*; play kept
clicking *"Go to my island"* and tapping keys without ever entering a game. The
canvas verbs are necessary but not sufficient: a blind agent can act by
coordinates, but it can't *find* an unlabeled node on a diorama it can't see.
(Test confound, noted honestly: my profile was in a fully-completed *"TRAIL
CHAMPION"* state, which added noise — but a completed trail still opens games by
node-tap, so the wall stands.)

**B. Synthetic drag doesn't satisfy the shelf's pointer-intent gesture (killed
task 2).** SceneBeans' `StickerShelf` uses a deliberate pointer contract —
*cells are `touch-none`; a flat sideways swipe scrolls; only a mostly-vertical
pull UP hands off to `onDragStart`*. bx's `drag` (Playwright mousedown → moves →
mouseup) does not appear to trip that heuristic, so the thing never detaches from
the shelf. Haiku's last reasoning: *"the shelf might be in the canvas itself or
accessed through different means."* Opus tried a real decomposed drag and still
couldn't commit it. **This is generalizable:** modern pointer-capture / DnD UIs
(touch-none + pointer-intent) often won't fire on `mouse.*` events alone.

**C. Cost inverted from "too cheap to matter" to the main risk.** Round 1 was
$0.24–$0.36/run. Round 2 is **$0.72–$1.65/run** (build alone $1.65, 10.7 min).
The higher turn caps + the *three-rung* ladder (haiku→sonnet→opus each running
to exhaustion) multiply the burn. Raising `--max-turns` doesn't help a task the
agent can't converge on — it just buys a more expensive failure. The real fix is
convergence + a spend ceiling, not more turns.

**D. Possible tab-isolation wobble under concurrency.** Both escalations began
with *"Page is blank (tab was closed)"* and every run's action log ends with
`closed tab 1`. Some of this is expected (the pin opens a fresh tab per attempt;
`close()` runs in `finally`). But "tab **1**" collides with the operator's own
active tab, and a *blank tab at escalation start* costs turns re-orienting. Worth
confirming that 3 concurrent agents + one hand-driven active tab can't stomp each
other's tab ids.

## Refined recommendations (Round 2)

**Cost governance is now P0 (it replaced debuggability).**
1. **Hard spend/wall ceiling per `bx agent`** (`--budget $0.25`, `--max-wall
   120s`) that aborts *and still emits the synthesized fail report*. A single
   `--opus` build hitting $1.65/10min unattended is a footgun.
2. **Don't run every rung to exhaustion.** If an attempt makes no measurable
   progress (no new URL, no state delta) for K turns, stop *that* rung early
   rather than burning its full budget before escalating. Escalate on
   *stall-detected*, not only on turn-exhaustion.

**Make the agent competent at canvas *navigation*, not just canvas *acting*.**
3. The system prompt teaches coordinate acting but not **how to find an
   unlabeled canvas target**. Add guidance: when a canvas has no affordance and
   no `bx_js` handle to click, prefer **app-exposed navigation** — call a store
   action / deep-link via `bx_js` (e.g. `window.__studio.getState().openEditor(id)`
   style hooks) instead of guessing pixel positions. For dev-testing your own
   app this is the intended path and dramatically cheaper than blind clicking.
4. Encourage a **`bx_js` "map" pass** on canvas pages: dump `Object.keys` of the
   exposed handles up front so the agent learns the vocabulary before acting.

**Fix the drag.**
5. Give `bx_drag` a **pointer-event mode** (dispatch `pointerdown/move/up` with
   `pointerId`, small inter-move delays, and enough steps) so it satisfies
   pointer-intent / touch-none DnD. Expose hold-at-start and per-step delay knobs.
   Today's mouse-only drag silently no-ops on a large class of modern UIs.

**Skill doc.**
6. **Push "default to `bx agent`" harder** (owner ask, carried from Round 1 #7):
   the by-hand section still reads as a co-equal option. Make `bx agent` the
   strong default for *anything task-shaped*; reserve hand-driving for quick
   single lookups and ground-truth setup.
7. **Periodic progress, not just end-of-run** (owner ask): the transcript file
   exists but a non-`--verbose` background run's **stdout is still silent until
   the final trailer**. Emit a heartbeat line (turn count / last action / cost so
   far) to stdout every N turns even without `--verbose`, so an operator watching
   the output file sees life. `--verbose` streaming to stderr is great; the
   default run should still show a pulse.
8. **Document the canvas-navigation caveat**: the agent is now solid at DOM and
   competent at canvas *acting/verifying via `bx_js`*, but **canvas
   *wayfinding* on an unlabeled diorama remains unreliable** — such apps need an
   app-exposed navigation handle to be agent-drivable, and the task prompt should
   hand the agent that handle.

## Round 3 success bar
- Task 1 passes when the prompt provides an app-nav handle (proves canvas
  *wayfinding* via `bx_js` works); document that dependency in the skill.
- Task 2 either passes with a pointer-mode drag, or the agent *reports* "drag did
  not register" as a clean fail (it already fails cleanly — pointer-mode is the
  real win).
- No run exceeds a set `--budget`; stall-detection ends dead rungs early.
- Cost per run back under ~$0.30 even with escalation.

---

# Round 3 — after cost-governance + pointer-drag + wayfinding (2026-08-07)

Re-ran with the shipped fixes: `--budget 0.30` (hard ceiling across the whole
ladder, aborts mid-rung + still reports), automatic stall-detection, a heartbeat
line every ~10 turns, `bx drag --pointer` (press-and-settle PointerEvents, ~120ms
hold), the agent prompted to map `window.__*` handles and prefer store
actions/deep-links, and escalations that resume in a fresh tab at the prior
rung's URL. Daemon was restarted onto the new code before testing.

## Verdict: canvas gamedev crossed from "falls apart" to "works, cheaply"

| Task | Handle named? | Tier | Turns | Wall | Cost | ended | Outcome |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 Open editor via `__studio` | **yes** | haiku | 36 | 44s | **$0.05** | report | **PASS** |
| 2 Drag + play (concurrent) | no | sonnet | 153 | 223s | $0.12 | **budget** | fail (never reached shelf) |
| 3 Play → win (concurrent) | partial | sonnet | 150 | 256s | $0.13 | **budget** | fail (reached play, no win) |
| 4 Drag, solo, handle-named | **yes** | haiku | 48 | 72s | **$0.09** | report | **PASS** (instances 30→31) |

### What's now verified working
- **Wayfinding via app-nav handle — PASS.** Task 1 opened *"Gumdrop Hop"* with
  `window.__studio.getState().loadShelf()` + `openProject(id)`, verified
  `__editorWorld` truthy + `screen==='editor'` — **Haiku, no escalation, $0.05.**
  The Round 2 entry-gate wall is gone *when the prompt names the handle.*
- **Pointer-drag — PASS (the Round 2 headline blocker).** The solo test
  (task 4) opened the editor, dragged shelf→stage in pointer mode, and confirmed
  **`scene.instances.length` went 30 → 31** via `bx_js`. Haiku, $0.09. The fix
  (press-and-settle timing; Round 2's failure was Playwright's ~30ms-to-first-move
  reading as a flick) is real. Notably the agent didn't even need the `--opus` it
  was allowed — Haiku did it.
- **Budget ceiling — PASS (was the new P0).** Both failing runs aborted at the
  ceiling with `ended=budget` and a clean synthesized report. No more $1.65 /
  10-minute runaways — the worst case is now a bounded, reported failure.
- **Heartbeat — PASS.** `… turn N · ~$X · last: <action>` every ~10 turns let me
  watch spend and progress live in the background output file. Exactly the
  periodic-progress ask.
- **Flow-save on PASS — PASS.** First green runs in the whole engagement, so the
  first `--save` artifacts: `flows/canvas-nav3.flow.ts`, `canvas-drag-solo.flow.ts`.
- **Tier discipline — good.** The two passes stayed on Haiku; escalation to
  Sonnet only happened on the genuinely-stuck concurrent runs.

### Bugs / rough edges found this round
1. **Fail-report evidence is cross-contaminated under concurrency (real bug).**
   Tasks 2 and 3 — different tabs, different runs — printed the *identical* "last
   8 actions" tail (`…Sunny Meadow → Go to my island → MY ISLAND 0 games →
   dragged 170,738→640,400 → closed tab 1`). The per-run **heartbeat** was
   correctly distinct, but the synthesized evidence block is pulled from the
   **shared global action log window**, not the attempt's own tab. With N
   concurrent runs the evidence is unreliable. Fix: scope the exhaustion/abort
   evidence to the run's own tab id (the actions are already tab-tagged for
   flows — reuse that filter here).
2. **Budget estimator ~2–3× pessimistic.** Runs aborted at "est $0.30" but the
   trailer's real metered cost was **$0.12–$0.13**. The ceiling works, but it's
   cutting runs off at roughly a third of the true dollar spend — a task that
   would really cost $0.28 gets killed early. Reconcile the live estimate with
   the metered figure (looks like cache-read tokens are being priced at full
   rate in the estimate).
3. **"Win a real game" is still the frontier.** Task 3 *reached* play mode
   (`window.__play` present) and introspected `__play.runner` for a win flag, but
   spent its whole budget hunting the state and never reached/detected a win.
   This isn't a bx bug — it's genuinely hard (real games need many precise timed
   inputs, and the win flag's location isn't obvious). To make it agent-testable,
   the app should expose a first-class win/verdict signal (e.g.
   `window.__play.runner.verdict`) and the task prompt should name it — same
   pattern that unlocked tasks 1 and 4.

### The through-line: **name the handle.**
Every PASS named the app-nav handle; every canvas FAIL either didn't (task 2) or
needed a win-signal that wasn't named (task 3). The wayfinding fix is real but
**prompt-dependent** — a "cold" canvas task with no handle still falls back to
blind clicking and burns budget. This is the documented intended path for
canvas-first apps; the skill should say so loudly (see rec).

## Recommendations (Round 3)
1. **Fix the concurrency evidence bug (P1).** Scope fail-report "last actions" to
   the attempt's own tab, not the global log.
2. **Fix the budget estimator (P1).** Align the live spend estimate with metered
   cost so `--budget` cuts at the real dollar figure, not ~3× early.
3. **Skill: make "name the app-nav handle for canvas apps" a first-class
   instruction**, with the win/verdict-signal corollary. Give the copy-paste
   shape: *"use `window.__store` to <navigate>, then verify via
   `window.__x.<signal>`."* Today it's implied; the data says it's the whole game.
4. **Optional: a `--handles` / warm-up hint** — let the caller pass known
   `window.__*` handles so the agent maps them turn 1 instead of discovering them
   (tasks 2/3 spent 20–40 turns just finding the vocabulary).
5. Keep Opus opt-in — Round 3's real work was all Haiku; Opus wasn't needed once
   wayfinding + pointer-drag landed. `--opus` is a safety net, not a default.

## Round 4 — winning a live game (separate doc)
The "win a real game" frontier got its own write-up:
**`plans/2026-08-07-winning-games-and-claude-chrome-parity.md`**. Headline: the
agent **won** Bee Dodge ($0.16) by authoring an in-page seek/avoid controller and
polling `runner.status==='won'` — a pattern screenshot agents can't execute — but
only when handed the exact entry recipe; "find the game and win" failed on budget
(entry *discovery*, not gameplay, is the cost sink). Asks there: `--enter`/`--win`
inputs (or a `bx drive` primitive), plus the same estimator + concurrency-evidence
fixes. Read that doc for the competitive positioning vs Claude Chrome.

## Bottom line across all three rounds
- **R1:** 0/3, undebuggable black boxes. **R2:** 0/3 but fully debuggable + `bx_js`
  works; blockers became visible (entry gate, drag timing, cost). **R3:** the two
  blockers with clean fixes (wayfinding, drag) both **PASS on Haiku for ~$0.05–
  0.09**; cost is bounded; failures are cheap and legible. Canvas gamedev went
  from "falls apart completely" to "works when you name the handle." Remaining
  work is polish (evidence scoping, estimator) + the genuinely-hard "win a live
  game" frontier.
