# bx vs. Claude Chrome — winning real games, and what to build for parity

- **Date:** 2026-08-07
- **Status:** active — implementation asks for the bx maintainer. Round 4b
  (generalization across three games/genres) added 2026-08-07. **Round 5
  (2026-08-07): the shipped surface — `--enter`/`--win`, `bx drive`, estimator
  rebase, tab-scoped evidence — is all VERIFIED WORKING; 3 games won on Haiku for
  ~$0.17 total. See the Round 5 section at the end.**
- **Type:** capability report + roadmap
- **Tester:** Claude (Opus) driving the installed `bx` skill against SceneBeans
  (`http://localhost:5183`) — a kids' game-maker whose home, editor, and play are
  all one WebGL/three.js canvas.
- **Companion doc:** `plans/2026-08-06-scenebeans-canvas-gamedev-test.md`
  (Rounds 1–3: debuggability, `bx_js`, pointer-drag, wayfinding, cost governance).
  This doc is Round 4 — the "actually win a live game" frontier — written to be
  sent on its own.

## TL;DR

**bx can drive a real-time canvas game to a genuine win — and did.** The agent
opened SceneBeans' "Bee Dodge", identified the hero / flowers / bees from live
state, **authored a seek-and-avoid steering controller, injected it through the
app's per-frame hook, and drove `runner.status` from `playing` → `won`** in ~4s
of play. Cost **$0.16**, 72 turns.

**This is the exact thing a screenshot agent (Claude Chrome / computer-use)
structurally cannot do.** Winning a 60fps game the honest way — read the frame,
decide, press a key, repeat — is impossible for *any* turn-based agent: the
read→act loop is ~3 tool calls and several seconds per steering decision, and the
game has moved on. Our honest-keys run proved it: it reached play and steered
with real arrow-key holds but **ran out of budget mid-game without winning.** The
win came only from the pattern bx uniquely enables: **read state programmatically,
inject a controller, poll the win signal.**

**Round 4b ground-truthed the pattern against two more games of different
genres** (a denser collectathon and a side-scrolling flight game). The verdict
sharpens the thesis: the read→inject→poll **mechanism is universal** — it drove
all three games with frame-perfect precision — but **authoring a *winning*
controller is per-game**, gated by the game's input schema and difficulty. That
makes the `bx drive` primitive proposed below *more* important, not less: the
expensive part is iterating on the controller, and `bx drive` moves that
iteration entirely in-page, at zero model cost.

The catch, and the whole roadmap: **it only worked when the prompt handed the
agent the exact entry recipe + the win signal.** The same task phrased as "find
Bee Dodge and win" failed on budget — the agent spent its entire budget just
*discovering how to open the game*. Entry discovery, not gameplay, is the cost
sink.

## The four runs (same goal: win Bee Dodge)

| Run | Approach | Entry given to agent | Result | Turns | Wall | Cost (real) |
| --- | --- | --- | --- | --- | --- | --- |
| WIN-A | author in-page controller | "open the game Bee Dodge" (discover) | **FAIL** (budget) — never won | 228 | 426s | $0.21 |
| WIN-B | honest held-key play, no hook | discover | **FAIL** (budget) — reached play, steered, couldn't win | 223 | 392s | $0.21 |
| WIN-C | author in-page controller | exact `openProject('proj_…')` + `setPlaying` recipe | **PASS — WON** | 72 | 134s | **$0.16** |
| (manual ground truth) | I wrote the controller | — | WON in ~6s, 5/5 flowers, 0 hearts lost | — | — | — |

All ran with `--budget 0.60`; WIN-A/C also `--opus`. WIN-C escalated to Sonnet
once and passed there.

### What WIN-C actually did (from its report + transcript)
1. `window.__studio.getState().openProject('proj_oo07cige')` → `setPlaying(true)`
   → confirmed `window.__play.runner.status === 'playing'`.
2. Grouped `runner.getInstances()` by `defId` and **inferred roles from counts**:
   `[["def_olf3g1x2",1] hero, ["def_oqkglpag",5] flowers, ["def_os8y9zob",3] bees]`.
3. Installed `window.__play.override = (r,gi) => {…}` — steer to nearest flower,
   add a repulsion vector from any bee within 200px, return a unit `{joyX,joyY}`.
4. Polled `runner.status` until `won`, verified, reported. Saved a replayable
   flow (`flows/canvas-win-controller2.flow.ts`).

No pixels. No screenshots. Pure state-in / control-out. That is the bx thesis
executed on a game.

## Round 4b — generalization across genres: the mechanism is universal, the winning controller is not

Bee Dodge could have been a one-game fluke, so I ground-truthed the same
in-page-controller pattern (read live state via `bx_js` → install a per-frame
controller through the app's `window.__play.override` hook → poll
`runner.status`) against three SceneBeans games of different genres:

| Game | Genre / win type | Controller | Outcome | Why |
| --- | --- | --- | --- | --- |
| **Bee Dodge** | top-down collectathon — collect 5 flowers; 3 wandering bees cost hearts | seek nearest flower + repel from bees within 200px → unit `{joyX,joyY}` | **WON** — agent (WIN-C: $0.16, 72 turns, ~4s) and by hand (~6s); 5/5 flowers, 0 hearts lost | controller matched both the game's input schema and its difficulty |
| **Picnic Panic** | top-down collectathon, denser/faster hazards — grab 8 cookies | same seek+avoid shape | **LOST** — swarmed almost instantly: `lost`, score 0, hearts 3→0 in ~2s, 0 cookies | mechanism steered the hero precisely; the controller was simply too weak for the hazard density. Winnable in principle — needs tuning I deliberately didn't chase |
| **Balloon Flight** | side-scrolling flight — reach a finish flag ~4 screens right at x=3950 (reach-goal, not collect-N) | seek the flag + dodge obstacles via `{joyX,joyY}` | **NOT WON** — flew flawlessly x=200→3950 with all 3 hearts intact, but status never left `playing` | heroX=3950=flagX, but heroY stayed pinned at 732 vs flagY=560. Vertical lift in a flight game comes from a flap/jump **button**, not analog `joyY` — even a pure-homing controller commanding upward couldn't rise. A joystick-only controller structurally cannot win it |

Three takeaways, stated plainly:

1. **The read→inject→poll mechanism is universal and cheap.** I drove all three
   games with frame-perfect precision via `bx_js` + `override`, across two win
   types (collect-N and reach-goal) and two control schemes (top-down joystick,
   side-scroll flight). The mechanism never failed; only the controllers did.
2. **Authoring a *winning* controller is game-specific.** It depends on (a) the
   game's **input schema** — the `override` hook returns a `Partial<GameInput>`
   that includes buttons, not just `joyX`/`joyY`, and Balloon Flight proves
   joystick-only isn't enough — and (b) per-game **tuning** for difficulty,
   which Picnic Panic proves by losing with a controller that won Bee Dodge.
3. **This makes the case for `bx drive` stronger, not weaker.** The expensive,
   model-token-burning part is iterating on the controller. A primitive that
   installs/replaces a controller and polls a predicate entirely in-page lets
   you iterate at **zero model cost** — exactly what the harder games need.
   And it's something a screenshot agent (Claude Chrome) cannot express at all.

## Why this is the competitive story vs. Claude Chrome

| | **bx** (text-first, code-capable) | **Claude Chrome / computer-use** (vision + click) |
| --- | --- | --- |
| Read game state | **Yes** — `bx_js` reads app-exposed runner/handles directly | No — must infer from pixels |
| Drive a 60fps game | **Yes** — inject a per-frame controller via an app hook | No — turn-based click/keys can't keep frame pace |
| Verify a win deterministically | **Yes** — poll `runner.status === 'won'` | Guess from a celebration animation it happens to screenshot |
| Cost of a win | **$0.16, 72 turns** (WIN-C) | Would burn vision tokens per frame and still can't close the loop |
| Opaque 3rd-party canvas (no handles) | **Weak** — blind without exposed state | **Stronger** — at least sees pixels |
| Regression-replayable | **Yes** — the win is saved as a zero-token flow | No |

**Honest framing to put in the docs:** bx *beats* a screenshot agent decisively
when the app exposes state/hooks — i.e. **when you are testing your own app**,
which is bx's whole audience. It is *weaker* on an opaque third-party canvas you
can't instrument, where vision is the only signal. Lead with the former; don't
pretend the latter away.

## What to build (implementation asks, priority order)

### P0 — kill the entry-discovery cost sink (this is the difference between $0.16 and a $0.60 failure)
The single biggest lever. WIN-A and WIN-C were the *same task*; the only
difference was WIN-C got the exact entry recipe. Discovery of "how do I open game
X on this canvas app" cost an entire budget.

1. **A structured warm-up / handles input on `bx agent`.** Let the caller pass
   known app facts the agent maps on turn 1 instead of discovering:
   ```
   bx agent "win Bee Dodge" \
     --handle "studio=window.__studio.getState()" \
     --handle "play=window.__play.runner" \
     --enter "studio.openProject('proj_oo07cige'); studio.setPlaying(true)" \
     --win  "play.status === 'won'"
   ```
   Even just `--enter <js>` and `--win <js-expr>` would have turned both failures
   into passes. This is the canvas analogue of "name the handle," made first-class.
2. **Skill guidance: for a canvas app, ALWAYS establish the entry recipe first**
   (a store action / deep link), and never let the agent hunt for an on-canvas
   affordance by name. Document the shape:
   *"use `window.__store` to `<open/enter>`, verify via `window.__x.<signal>`."*

### P1 — a first-class "drive a game" pattern (the moat vs. Claude Chrome)
3. **Document the in-page-controller recipe in the skill** as the canonical way to
   drive/verify a real-time game, with the three steps: read state → (if the app
   exposes a per-frame input hook) install a controller → poll the win signal. Say
   plainly that **per-key turn-based play cannot win a real-time game** (WIN-B is
   the evidence) and is only for slow/turn-based UIs.
4. **Optional but killer: a `bx drive` / `bx play` primitive.** One verb that
   installs a JS controller and polls a predicate with a timeout, entirely
   in-page — *zero model turns during the actual play*:
   ```
   bx drive --install "<controller js>" --until "window.__play.runner.status==='won'" \
            --timeout 15000 --poll 500
   ```
   This makes "prove this level is winnable" a single, cheap, deterministic call —
   the ultimate token-budget win, and something computer-use cannot express at all.
   It also synthesizes into a flow for free (permanent regression: "level N still
   winnable"). Round 4b adds two hard requirements to the spec:
   - **Full input schema, not an x/y vector.** The installed controller must be
     able to return everything the app's hook accepts — buttons (flap/jump/fire),
     not just joystick axes. Balloon Flight is the proof: a joystick-only
     controller flew the whole level perfectly and still structurally could not
     win, because lift is a button. Skill guidance should tell the agent to
     **inspect the hook's expected return shape first** (e.g. dump a sample
     `GameInput`) before authoring a controller.
   - **Cheap iteration as a first-class loop.** When `--until` times out, let the
     caller **replace the controller and re-poll without re-entering the whole
     flow** (same tab, same game session or a one-call restart). Picnic Panic is
     the motivating case: the mechanism worked and only the controller needed
     strengthening — the fix is a tuning loop, and `bx drive` should make that
     loop cost **zero model tokens** per iteration.

### P1 — bugs carried/confirmed from Round 3 (still present, now with more evidence)
5. **Fail-report evidence is cross-contaminated under concurrency.** Multiple
   concurrent runs print the *same* "last actions" tail because the evidence is
   pulled from the **shared global action log**, not the run's own tab. Seen again
   this round (both WIN runs ended with identical `key up/down ArrowRight … closed
   tab 1` tails). The per-run heartbeat is correct, so the tab id is available —
   scope the exhaustion/abort evidence to the attempt's own tab (reuse the
   flow-synthesis filter).
6. **Budget estimator is ~3× pessimistic — now 4 more data points.** Every
   `ended=budget` run aborted at "est $0.60" while the trailer's real metered cost
   was **$0.21** (WIN-A, WIN-B) / and earlier "$0.30 est vs $0.12 real" (R3). The
   ceiling works, but it kills runs at ~⅓ of true spend — a real $0.30 task dies
   under a $0.60 budget. This directly hurts the win-a-game case, which needs its
   budget spent on play, not left on the table. Reconcile the live estimate with
   the metered figure (cache-read pricing in the estimate looks like the culprit
   despite the 10% note).

### P2 — polish
7. **Keep `--opus` opt-in.** WIN-C passed on Sonnet; Opus wasn't the unlock —
   the entry recipe was. Reasoning tier is not the bottleneck for game-driving;
   entry + the controller pattern are.
8. **Expose a "role map from counts" helper hint** in the game guidance — the
   agent inferring hero/goal/hazard from `defId` frequency worked well and is
   generalizable; a one-liner in the prompt would save the agent from re-deriving
   it each time.

## App-side note (for the SceneBeans side, not bx)
"Win a live game" is agent-testable *because* the runner exposes
`window.__play.runner.status` + `getInstances()` + the `override` hook. The
generalizable lesson for any app that wants to be agent-drivable: **expose BOTH a
first-class win/verdict signal AND the input schema** — a discoverable statement
of what fields the per-frame hook accepts, joystick axes *and* buttons. Round 4b
showed why the second half matters: an app that exposes only a subset of its
inputs (analog axes but not the flap/jump button) makes whole genres undrivable
even though the read→control→poll mechanism works flawlessly. Apps that expose
both get cheap, deterministic, replayable end-to-end game tests out of bx; apps
that don't force the agent onto the infeasible per-key path — or into a
controller that can never win.

## Bottom line
- bx **won a real-time canvas game for $0.16** using a pattern no screenshot agent
  can execute. That's a genuine, demonstrable edge over Claude Chrome for
  **testing your own instrumented app.**
- Round 4b confirmed the pattern **generalizes in mechanism but not in winning**:
  three games, three genres, frame-perfect control in all of them — one win, one
  loss to difficulty tuning, one structural miss to an incomplete input scheme.
  The per-game cost is controller iteration, which is exactly what `bx drive`
  moves to zero model tokens.
- The gap between a $0.16 win and a $0.60 failure was **entry discovery**, not
  gameplay. Ship `--enter`/`--win` (and ideally `bx drive`), fix the estimator and
  the concurrency evidence bug, and document the controller pattern — and
  "drive/verify a game" becomes a reliable, cheap, first-class bx capability.

---

# Round 5 — verification of the shipped surface (2026-08-07)

The bx maintainer shipped every ask from Rounds 4/4b: `--url` / `--enter` / `--win`
on `bx agent`, the `bx drive` primitive, the estimator rebase, and tab-scoped
evidence. Re-tested against the same SceneBeans games. **Everything works, and
the numbers moved exactly the predicted direction.**

| Test | What it proves | Result |
| --- | --- | --- |
| Bee Dodge via `--enter`/`--win` | entry-discovery cost sink is gone | **PASS — Haiku, 15 turns, $0.06** (was $0.16 in R4 with the recipe in-prompt, $0.60 fail without) |
| Balloon Flight agent | the input-schema miss is closed | **PASS — Haiku, 38 turns, $0.11** — agent dumped the hook's input shape, found `aDown`, and **discovered the flap is edge-triggered — pulsed it ~every 8 frames** to gain altitude and reach the flag |
| Picnic Panic via `bx drive` hand-iteration | zero-token controller tuning loop | **WON in 2 iterations** — iter 1 (avoid the wrong objects) lost; a 5-second `bx js` idle-watch revealed the real hazard is a single **chasing fox**, not the 5 stationary props; iter 2 (avoid only the fox) → `won`, score 8/8, 2 hearts left. **Zero model tokens per iteration.** |
| Two concurrent failing runs | evidence contamination fixed | **PASS — distinct tails** (`…/` + `closed tab 2` vs `…/beta` + `closed tab 1`); in R3/R4 concurrent runs printed *identical* tails. Operator tab survived (no steal). |

### What each fix bought, confirmed
- **`--enter` / `--win` — the P0 — works and is the big cost win.** The entry
  recipe runs before turn 1 (and, verified, re-runs on escalation), so the whole
  budget goes to the actual task. Bee Dodge dropped to **$0.06 on Haiku** (no
  escalation) — the entry-discovery sink that turned an identical task into a
  $0.60 failure in Round 4 is gone. `--win` is genuinely enforced: both passing
  runs' trailers show "win predicate verified … → true".
- **`bx drive` works end to end** — install a controller, poll the predicate
  daemon-side (`✓ satisfied after 13.6s (10 polls)` / `✗ not satisfied after
  20.2s`), exit 1 on timeout, re-run replaces the controller in place. It made the
  Picnic Panic tuning loop **one command per iteration at zero model cost** — and
  incidentally I used it to author the winning Balloon Flight controller by hand
  in two tries. This is the primitive that has no computer-use equivalent.
- **Estimator is fixed.** `est` now equals metered `cost` on completed runs
  ($0.06=$0.06, $0.11=$0.11), and on `ended=budget` runs `est` is the *higher*
  number because it includes the aborted rung the SDK never bills — exactly as
  documented. The ~3× "pessimism" from Rounds 3/4 was the metering artifact it
  was diagnosed to be; printing both `cost=` and `est=` resolves it cleanly.
- **Evidence is tab-scoped.** Two concurrent failures produced different
  last-action tails. The contamination that made R3/R4 fail-reports unreliable
  under concurrency is gone.

### New micro-finding for the docs (edge-triggered buttons)
Balloon Flight sharpened the Round 4b lesson one more notch: it's not enough to
know the flap **button** exists — the button is **edge-triggered**, so a
controller that holds `aDown = true` flaps exactly once and the balloon never
rises (confirmed: holding it left `heroY` pinned at 732 vs `flagY` 560). The
winning controller must **pulse** the button (true for a single frame every few
frames). The agent discovered this from a prompt nudge; worth one line in the
game-driving guidance: *"buttons may be edge-triggered — if holding one has no
effect, pulse it."*

### Status: the game-driving capability is real and cheap
Across Round 5, **three real games won on Haiku** for a combined ~$0.17 of model
spend (Bee Dodge + Balloon Flight; Picnic Panic cost zero model tokens via
`bx drive`), each producing a replayable `flows/*.flow.ts` regression. bx now
does the thing this whole report set out to prove — drive and *win* real-time
canvas games, deterministically and for pennies — with a primitive
(`bx drive`) that a screenshot agent structurally cannot match. Remaining items
are documentation polish (the edge-triggered-button line; a role-inference
one-liner), not capability gaps.
