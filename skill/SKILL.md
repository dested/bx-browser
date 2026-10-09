---
name: bx
description: "Drive, verify, and record web apps through the bx CLI (token-budgeted browser automation). Use INSTEAD of browser MCP tools (claude-in-chrome/computer-use) whenever the task is: open a page, click through a UI, fill forms, verify a fix or behavior, capture console/network errors, record a workflow, run/author a regression flow, or drive a canvas/game. Trigger on: 'open the app', 'click through', 'verify in the browser', 'check the console', 'record this flow', 'test the game', URLs of local dev servers."
---

# bx — browser automation as a CLI

A background daemon owns a real Chrome with a persistent profile (logins survive
between sessions). Every verb is a plain Bash call — no tool schemas, no
screenshot loop. Output is budgeted at the source (`els` ~800 tokens, `text`
~2000, console/net 30 entries), so never ration `bx els`. Act on text, not
pixels; screenshot only when the question is genuinely visual.

## `bx agent` is the default. Hand-driving is the exception.

If the work can be phrased as a task with a checkable outcome — "log in and
check the invoice list", "add an item and verify the total", "reproduce the
toggle bug" — delegate it. Do not drive step by step first "to see the page";
the agent orients itself faster and cheaper than you can, and your context
stays clean. Hand-drive ONLY for: a single quick lookup (one `els`/`text`),
ground-truth setup before judging an agent, or interactive debugging where you
must see each intermediate state. When in doubt, delegate.

```bash
bx agent "log in as demo@acme.test and verify the invoice list loads" --save invoices
```

- Runs on **Haiku** (one-shot Sonnet escalation on failure) and returns a
  ~300-token pass/fail report with evidence. Ends with a trailer —
  `tier=haiku turns=14 wall=25.9s cost=$0.037` — quote it when reporting.
- The trailer prints both `cost=$` (metered) and `est=$` (the governance
  estimate). On aborted runs `est` includes the aborted rung's spend, which
  metered cost structurally cannot — so `est` is the number to trust when a run
  hit `--budget` or `--max-wall`.
- `--opus` allows one FINAL escalation Sonnet → Opus 4.8. Complex flows only
  (long multi-page journeys, gnarly canvas work) — ~5× Sonnet cost. Don't pass
  it by default; add it when a Sonnet attempt already failed on a task that
  genuinely needs the extra reasoning. `--model opus` runs Opus directly.
- Typical real-app DOM task: 10–40 turns, 15–75s, $0.02–0.06. Measured 7/7
  correct on a production app. Canvas tasks run longer — raise the budget with
  `--max-turns 60` for multi-step game work.
- Every run writes a full turn-by-turn transcript to `~/.bx/agent-runs/` (path
  in the trailer); `--verbose` streams it live to stderr; a heartbeat line
  (turn · est cost · last action) prints every ~10 turns regardless. A failed
  run's report says where it got stuck — read it before re-running.
- **Set `--budget <usd>` on anything exploratory** (e.g. `--budget 0.25`) and
  `--max-wall <s>` on anything unattended — the run aborts cleanly with a fail
  report instead of burning the full escalation ladder. Stalled rungs (same
  actions repeating, no progress) end early and escalate on their own.
- Canvas wayfinding caveat: the agent verifies canvas state well via `bx_js`,
  but it cannot FIND an unlabeled target on a canvas it can't see. For
  canvas-first apps, put an app-exposed handle in the instruction (e.g. "use
  window.__studio to open the first game's editor") — that is the intended
  path, and blind pixel-guessing is what burns budgets.
- **Fan out freely.** Every agent run is pinned to its own browser tab with its
  own element refs — concurrent agents cannot interfere with each other or with
  your own bx commands (which use the active tab). Tested 5-wide; launch
  independent read/verify tasks in parallel, one Bash call each.
- `--save <name>` writes the actions AND passing assertions to
  `flows/<name>.flow.ts` — replayable forever at zero model tokens.

Drive verb-by-verb only for quick single lookups, exploratory poking, or when
you must see intermediate state yourself.

## Driving by hand

```bash
bx open https://myapp.localhost      # navigates, prints title + numbered elements
bx els                               # [1] link "Home"  [3] button "Save changes"
bx click 3                           # act on the ref
bx fill 5 "me@example.com"
bx expect text "Saved"               # exit 1 if it fails
```

Refs are per-scan and go stale by design: after navigation, re-run `bx els` —
or pass text (`bx click "Save changes"`), which survives re-renders.

**Target syntax** (auto-detected): `3` → ref from the last `els`; `#id`,
`.class`, `[attr]`, `//xpath`, `css=`, `xpath=` → selector; anything else →
text, matched against `data-testid`, role+name, label, placeholder, visible
text — in that order.

| Verb | Syntax | Notes |
| --- | --- | --- |
| open | `bx open <url>` | navigate; prints title + element list |
| els | `bx els [--all] [--filter <text>]` | numbered interactive elements |
| click / fill / select | `bx click <target>` · `bx fill <t> <v>` · `bx select <t> <v>` | auto-wait |
| press | `bx press <key>` | one-shot key/chord: `Enter`, `Control+a` |
| wait | `bx wait <text\|selector\|ms>` | number = sleep, else wait visible |
| expect | `bx expect text\|url\|visible\|not-visible <value>` | exit 1 on fail; `--timeout <ms>` |
| text / js | `bx text [selector]` · `bx js <expr>` | budgeted reads |
| console / net | `bx console [--filter <re>]` · `bx net --failed` | errors first |
| snap | `bx snap [path] [--full]` | downscaled PNG path — `Read` it only if needed |
| tabs | `bx tabs` · `bx tab <n>` · `bx tab new [url]` · `bx tab close [--others\|--all]` | `--others` keeps the active tab, `--all` closes every tab — clean up when done |
| run | `bx run <flow.ts> [--record]` | replay a flow; zero model tokens |
| drive | `bx drive --install "<js>" --until "<expr>" [--timeout <ms>] [--poll <ms>]` | in-page controller + poll; exit 1 on timeout |
| agent | `bx agent "<task>" [--model haiku\|sonnet\|opus] [--opus] [--save <n>] [--max-turns <n>] [--budget <usd>] [--max-wall <s>] [--url <u>] [--enter <js>] [--win <expr>] [--verbose]` | delegate |
| record | `bx record start <slug>` / `bx record stop` | video → narrated package |
| admin | `bx status` / `bx profiles` / `bx stop [--all]` | daemon lifecycle; idle daemons exit after 15 min |

Global flags: `--profile <name>` (default `default`), `--headless`, `--json`
(includes an `ms` timing field), `--timeout <ms>`. `BX_TIMING=1` prints wall
time to stderr per command. The daemon starts on first use, one per profile.

## Clean up when you're done

The browser is persistent — tabs you open by hand stay open across commands and
across sessions until something closes them. Leaving a pile behind is a mess for
whoever is watching the real Chrome window. So, at the end of a hand-driven
task:

```bash
bx tab close            # close the one tab you were driving
bx tab close --others   # done exploring across several tabs — keep this one, close the rest
bx tab close --all      # wipe every tab back to a single blank one
```

`bx open` reuses the active tab (it navigates, it does not spawn a tab), so a
straightforward open→check→verify leaves nothing to clean up. It's `bx tab new`
and multi-tab exploration that accumulate — close them before you report done.

**`bx agent` cleans up after itself:** every run drives its own tab and closes
it automatically when it finishes, pass or fail. You never close agent tabs by
hand — a leftover agent tab means the daemon was killed mid-run, so
`bx tab close --others` (or `bx stop`) is the recovery.

**Stop the daemon when you're finished, and reuse profile names.** Each profile
is its own daemon plus its own Chrome, and they don't go away when your task
ends. When you're done with a profile, run `bx --profile <name> stop`. Idle
daemons also exit on their own after 15 minutes (`BX_IDLE_MINUTES`, `0` =
never). `bx stop --all` stops every daemon at once. Don't invent a fresh
`--profile` name for every check: reuse the project's existing profiles, and
create a new one only when you truly need separate logins or concurrent
sessions. Every new profile is a new Chrome data directory that has to warm up
from cold.

## Canvas, games, non-semantic UIs

When there's no DOM to target, use coordinates — element-relative via `--in`
so positions mean "inside the canvas":

```bash
bx mouse click 200 150 --in "game-canvas"   # also: dblclick, move, down, up
bx drag 50 50 300 200 --in "game-canvas"    # mousedown → moves → mouseup
bx drag 50 50 300 200 --in "shelf" --pointer  # press-and-settle PointerEvents:
                                              # real DnD often needs a ~120ms
                                              # hold + capture-correct delivery,
                                              # not Playwright's instant drag
bx key down w                               # hold a key (WASD movement)
bx wait 500
bx key up w
bx wheel -120 --in "game-canvas"            # scroll/zoom
```

If a mouse-mode drag "succeeds" but nothing moved, the target's DnD likely
requires press-and-settle timing (a hold before the first move) — retry with
`--pointer`, and tune `--hold <ms>` if it still doesn't take.

Pair with `bx js` to read game state the app exposes, and `bx snap` when the
claim is visual. These log to the action log and synthesize into flows like
every other verb.

## Real-time games: the in-page controller pattern

Turn-based play cannot win a real-time game — a read→decide→keypress loop is
seconds per decision and the game runs at 60fps. Don't try. When the app
exposes a per-frame input hook, drive it in-page instead:

```bash
# 1. map state, find the hook, dump ONE sample of the FULL input it accepts
bx js "Object.keys(window).filter(k => k.startsWith('__'))"
bx js "window.__play.runner.getInstances().map(i => i.defId)"  # 1-of = hero, N-of = goals/hazards

# 2. install a controller + poll the win signal — zero model tokens during play
bx drive --install "window.__play.override = (r, gi) => { /* seek goal, avoid hazards */ }" \
         --until "window.__play.runner.status === 'won'" --timeout 15000 --poll 500

# 3. lost or timed out? revise and re-run bx drive — it replaces the controller in place
```

Mind the input schema: hooks often accept buttons (jump/flap/fire) as well as
axes — a joystick-only controller cannot win a game whose lift is a button.
Buttons may also be edge-triggered: if holding one has no effect, pulse it
every few frames instead.
`bx drive` logs to the action log and synthesizes into flows: "level N still
winnable" becomes a zero-token regression test.

For `bx agent` on a canvas app, kill the entry-discovery cost sink with the
new flags — discovery of "how do I open X", not gameplay, is what burns
budgets:

```bash
bx agent "win Bee Dodge" --url https://app.localhost \
  --enter "window.__studio.getState().openProject('proj_x'); window.__studio.getState().setPlaying(true)" \
  --win "window.__play.runner.status === 'won'" --budget 0.30
```

`--enter` runs before the model's first turn (and re-runs on each escalation
rung); `--win` is handed to the model as the success predicate AND verified by
the driver before a pass is accepted.

## Verify a fix (the default trio)

```bash
bx expect text "Order placed"    # or: expect url /orders/, expect visible ...
bx console                       # errors + warnings only
bx net --failed                  # 4xx/5xx/aborted
```

## Record a walkthrough

```bash
bx record start checkout-bug
# …drive, or bx run flows/checkout.flow.ts --record…
bx record stop
```

Produces `recordings/<slug>/`: deduped keyframes, 3×3 contact sheets, and a
`report.md` narrated by the action log (passwords redacted). Point the user at
`report.md`.

Recording follows the **driven tab**, not whichever tab is on screen — with
several tabs open (e.g. a `bx agent` running in its own pinned tab) the captured
video is the tab that received the actions, selected by action activity rather
than file size. If the driven tab's video is somehow lost, `bx record stop`
errors loudly instead of shipping a blank video from an idle tab.

## Artifacts

- `flows/*.flow.ts` — typed regression tests; **commit them** to the project.
- `recordings/` — bulky; add to the project's `.gitignore`.
- `~/.bx/` — daemon state, snaps, logs, profiles. Never commit.

## Notes

- Exit codes: 0 ok · 1 command/expect failed · 2 usage · 3 daemon/browser.
  Unresolved targets list did-you-mean candidates — read them before retrying.
- If a target won't resolve, `bx els --filter <word>` beats guessing.
- Git Bash on Windows: bx auto-repairs MSYS path mangling of `/`-leading args
  (`expect url "/portal"` is safe). If something still looks rewritten, prefix
  the command with `MSYS_NO_PATHCONV=1`.
- First run of a profile: the user signs in once by hand; state persists.
- A failing `expect` waits its full timeout (default 5s) — pass `--timeout 500`
  when probing for absence.
- `bx click` is a **trusted** click (CDP-dispatched, `isTrusted=true`), not a
  synthetic `el.click()`/`dispatchEvent` — it drives React's event delegation and
  SPA client routers (Next `<Link>`, etc.) exactly like a human click. If an
  in-app link *seems* not to navigate, that's app/timing-specific — a popover
  unmounting the anchor on `mousedown`, or state read before the async client
  transition settled — **not** a harness synthetic-click limitation. Confirm the
  route with `expect url /path/` or `expect text …` (they retry until timeout);
  a bare `js location.pathname` right after the click can read the pre-transition
  URL and lie.
- Where bx wins, honestly: on an app that exposes state and hooks — your own
  instrumented app, the intended audience — bx beats screenshot agents
  decisively: real state reads, real-time driving via in-page controllers,
  deterministic verification, at cents. On an opaque third-party canvas with no
  exposed handles, a vision agent sees pixels and bx does not — hand-drive by
  coordinates or instrument the app.

Install: `bun add -g bx-browser && bx install-skill` (from a checkout:
`bun link`, then `bx install-skill`).
