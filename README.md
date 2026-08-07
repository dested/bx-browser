# claude-browser (`bx`)

Purpose-built browser automation for Claude Code — a CLI over playwright-core
and real Chrome that replaces the Claude in Chrome extension for driving your
own apps.

Four principles:

- **CLI, not MCP.** Verbs are Bash calls (~10 tokens of overhead), not tool
  schemas sitting in context. A skill teaches the model the verbs.
- **Deterministic replay.** Flows are typed TS artifacts; re-running one costs
  zero model tokens and doubles as a regression test.
- **Cheap model drives, expensive model reads the report.** Haiku (escalating
  once to Sonnet) does the clicking; your main session gets a ~300-token verdict.
- **Text-first observation, pixels at checkpoints.** Distilled element lists with
  a hard token cap; screenshots only when the judgment is visual.

## Why

Claude in Chrome puts the expensive model inside the per-action loop: every
click is screenshot → reason → coordinates → screenshot, at ~1.1–1.6k image
tokens each, all retained in context — and `read_page` accessibility dumps run
5–30k tokens on top of ~24 always-loaded tool schemas. bx inverts that: the
model reads a ~800-token element list, issues one-line commands, and once a path
works it becomes a flow file that never needs a model again.

Where bx wins, honestly: on an app that exposes state and hooks — your own
instrumented app, the intended audience — bx beats screenshot agents
decisively: real state reads, real-time driving via in-page controllers,
deterministic verification, at cents. On an opaque third-party canvas with no
exposed handles, a vision agent sees pixels and bx does not — hand-drive by
coordinates or instrument the app.

## Install

```bash
bun add -g bx-browser   # puts `bx` on your PATH
bx install-skill        # copies the skill to ~/.claude/skills/bx
```

Same two lines on macOS, Linux, and Windows. The skill is what makes it
automatic: Claude Code reaches for bx on its own whenever a browser task shows
up — after installing, just say "use bx to verify your changes".

`bx agent` runs through the Agent SDK with the same auth Claude Code itself
uses — on a Max subscription that means no API key and no separate bill. Note:
if `ANTHROPIC_API_KEY` is set in your environment, the Agent SDK bills the API
instead; that is Claude Code's auth-resolution order, not something bx
controls. Unset it to stay on the subscription.

From a checkout instead:

```bash
git clone https://github.com/dested/claude-browser
cd claude-browser
bun install
bun link          # puts `bx` on your PATH
bx install-skill
```

Requires Google Chrome installed (bx drives the real binary, not a bundled
Chromium). The first `bx open` in a profile launches a fresh Chrome with an empty
user-data-dir under `~/.bx/profiles/<name>` — sign in to whatever you need once,
by hand; the session persists across runs.

## Quickstart

```
$ bx open https://myapp.localhost
✓ Acme — Sign in — https://myapp.localhost/login

[1] textbox "Email"
[2] textbox "Password"
[3] button "Sign in"
[4] link "Forgot password?"

$ bx fill 1 demo@acme.test
✓ filled "1" with "demo@acme.test"

$ bx fill 2 hunter2
✓ filled "2" with "hunter2"

$ bx click 3
✓ clicked "3"
→ https://myapp.localhost/dashboard — Acme — Dashboard

$ bx els
[1] link "Dashboard"
[2] link "Invoices"
[3] button "New invoice"
[4] button "Account"

$ bx expect text "Welcome back"
✓ expect text "Welcome back"
```

Refs come from the last `els` scan and go stale on navigation by design —
re-run `els`, or pass text (`bx click "New invoice"`) which survives re-renders.
Targets resolve as: a number is a ref; a string starting with `#`, `.`, `[`,
`//`, `css=`, `xpath=` is a selector; anything else is text matched against
`data-testid`, role+name, label, placeholder, then visible text.

## Flows

```ts
// flows/examples/login.flow.ts
import { flow } from "bx/flow";

export default flow("login", async (b) => {
  await b.open("https://myapp.localhost");
  await b.fill("email", "you@example.com");
  await b.fill("password", "correct-horse-battery-staple");
  await b.click("Sign in");
  await b.expectText("Dashboard");
});
```

```bash
bx run flows/examples/login.flow.ts
bx run flows/examples/login.flow.ts --record   # replay and capture the video package
```

Flows are typechecked by `tsc`, live in version control, and cost nothing to
run. A pass prints `PASS <name> (<ms>ms, <n> steps)`; a failure prints
`FAIL <name> at <last step>: <message>` with the last five console errors and
exits 1, so flows drop straight into CI or a pre-push hook. The context `b`
carries the CLI's verbs — `open`, `click`, `fill`, `select`, `press`,
`waitText`/`waitFor`/`sleep`, the four `expect*` assertions, `snap`, `text`,
`js`, `back`, `reload` — with `wait` split into three explicit methods and no
`els` (a flow already knows its targets; use `text()` or `snap()` if you need
page state). See `flows/examples/verify-toggle.flow.ts` for the
assert-and-capture shape.

## Agent

```bash
bx agent "log in as demo@acme.test and verify the invoice list loads"
bx agent "add the second item to the cart and check the total" --save cart
bx agent "reproduce the toggle bug on the settings page" --model sonnet
bx agent "win Bee Dodge" --url https://app.localhost \
  --enter "window.__studio.getState().setPlaying(true)" \
  --win "window.__play.runner.status === 'won'" --budget 0.30
```

A headless Claude Agent SDK session drives bx's verbs on Haiku by default. On
the first failure it escalates once to Sonnet, which is better at repair and
indirection; the tier that produced the result is reported. With `--opus` a
failed Sonnet attempt escalates one final time to **Opus 4.8** — opt-in only,
for complex flows (long multi-page journeys, hard canvas work) at ~5× Sonnet
cost. `--model opus` starts there directly. Every run writes a turn-by-turn
transcript to `~/.bx/agent-runs/` and a failed run's report says where it got
stuck; `--verbose` streams the drive live, `--max-turns <n>` raises the
per-attempt budget (default 40) for long tasks. On a canvas app, entry
discovery — "how do I open X" — is the real cost sink, not the task itself:
`--url <u>` opens the page, `--enter <js>` runs setup before the model's first
turn (and again on each escalation rung), and `--win <expr>` is both handed to
the model as the success predicate and verified by the driver before a pass is
accepted. What comes back is a
short structured report — pass/fail, one-paragraph summary, evidence lines,
turns, token usage — not a transcript. With `--save <name>` the actions actually
taken AND the assertions that passed are synthesized into
`flows/<name>.flow.ts` using replay-stable targets (testids and accessible
names, never refs), so the next run is deterministic.

**Fan out freely.** Every agent run is pinned to its own browser tab with its
own element-ref registry — concurrent agents cannot navigate or scan each
other's pages, and your own `bx` commands (which use the active tab) don't
collide with them either. Measured on a real production app: 5 concurrent
agents, 7/7 task correctness, $0.02–0.06 per task on Haiku.

## Canvas and games

When there's no DOM to target — canvas games, charts, drag-and-drop — drive by
coordinates. With `--in <target>` the coordinates are relative to that
element's top-left, so positions mean "inside the canvas" at any window size:

```bash
bx mouse click 200 150 --in "game-canvas"   # also dblclick, move, down, up
bx drag 50 50 300 200 --in "game-canvas"    # mousedown → interpolated moves → mouseup
bx key down w                               # hold a key…
bx wait 500
bx key up w                                 # …WASD movement, charge attacks, etc.
bx wheel -120 --in "game-canvas"            # scroll / zoom
```

All four log to the action log, synthesize into flows, and are available to
`bx agent` — pair them with `bx js` to read whatever state the game exposes.

### Real-time games

A read→decide→keypress loop is seconds per decision and the game runs at 60fps,
so turn-based play cannot win one. When the app exposes a per-frame input hook,
`bx drive` installs a controller in the page and polls a predicate until it goes
truthy — zero model tokens for the whole run, exit 1 on timeout:

```bash
bx drive --install "window.__play.override = (r, gi) => { /* seek goal, avoid hazards */ }" \
         --until "window.__play.runner.status === 'won'" --timeout 15000 --poll 500
```

Re-running `bx drive` replaces the controller in place, so revising a losing
controller is one command. Mind the input schema — hooks often accept buttons
(jump/flap/fire) as well as axes, and buttons may be edge-triggered: if holding
one has no effect, pulse it every few frames. Runs log to the action log and
synthesize into flows, which turns "level N still winnable" into a zero-token
regression test.

## Recording

```bash
bx record start checkout-bug
# drive by hand, or: bx run flows/checkout.flow.ts --record
bx record stop
```

Chrome records video; bx pipes the webm through
[`video-to-prompt`](https://github.com/dested/video-to-prompt) inside a harness
page in the browser it already controls, and writes an agent-ready package to
`recordings/<slug>/`: deduped keyframes, 3×3 contact sheets, and a `report.md`
written for a model to read. There is no audio track — bx's own action log
("clicked Save changes", "filled Email with me@x.com") becomes the timed
transcript, so the report reads as a narrated walkthrough.

## Claude Code integration

```bash
cp -r skill ~/.claude/skills/bx
```

The skill teaches the verbs, the target syntax, and — importantly — when to
delegate to `bx agent` instead of driving step by step. It costs a few hundred
tokens only when triggered, where an MCP server's tool schemas are resident in
every context regardless of whether the browser is ever touched.

## Profiles and the daemon

One daemon per profile, started on demand, holding one Chrome instance.
`bx --profile work open …` uses a separate identity; `bx status` shows what's
running, `bx profiles` lists them, `bx stop` shuts the current one down.

| Path | Contents |
| --- | --- |
| `~/.bx/profiles/<name>/` | Chrome user-data-dir — cookies, logins, extensions |
| `~/.bx/run/<name>.json` | port + auth token for the live daemon; deleted on exit |
| `~/.bx/logs/<name>.log` | daemon stdout/stderr |
| `~/.bx/snaps/` | screenshots from `bx snap` |

Add `--headless` for CI (decided per daemon, at start), `--json` for machine
output (includes an `ms` wall-time field), `--timeout <ms>` to override the
5000ms default on click, fill, select, wait and expect. `BX_TIMING=1` prints
each command's wall time to stderr. `bx help` prints the full verb list.

Artifacts: `flows/*.flow.ts` are project files — commit them like tests.
`recordings/` is bulky — add it to your project's `.gitignore`.

## Windows / Git Bash

Git Bash (MSYS) rewrites `/`-leading arguments into Windows paths before any
program sees them — `bx expect url "/portal"` would arrive as
`C:/Program Files/Git/portal`. bx detects and repairs this automatically (it
strips the exact MSYS prefix back off). If an argument still looks mangled,
prefix the command with `MSYS_NO_PATHCONV=1`.

## Architecture

```
  bx CLI ──┐
  flows ───┼──▶ localhost HTTP ──▶ daemon (one per profile)
  agent ───┘      POST /cmd            │
                                       ├─ playwright-core ──▶ real Chrome
                                       │     locators, auto-wait, persistent profile
                                       ├─ distiller ────────▶ els / text / console / net
                                       │     budgeted output, ring buffers
                                       └─ recorder ─────────▶ webm ──▶ harness page
                                                                        video-to-prompt
                                                                        ──▶ recordings/<slug>/
```

## Status

v1: managed persistent profiles, headless-able and CI-able — the default and the
only backend that ships today. v2 is a bridge extension built on playwright-crx
that drives your real daily-driver Chrome profiles from inside the browser
(Chrome 136+ blocks CDP on the default user-data-dir, and app-bound encryption
blocks cookie import, so an extension is the only route). See
[`decisions.md`](decisions.md).

Site: [bx.dested.com](https://bx.dested.com) (source under [`site/`](site/)).
