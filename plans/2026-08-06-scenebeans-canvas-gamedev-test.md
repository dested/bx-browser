# SceneBeans canvas / gamedev shakedown — bx agent

- **Date:** 2026-08-06
- **Status:** active (findings for the maintainer; expect a re-test after fixes)
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
