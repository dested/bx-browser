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

## Install

```bash
git clone https://github.com/dested/claude-browser
cd claude-browser
bun install
bun link          # puts `bx` on your PATH
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
```

A headless Claude Agent SDK session drives bx's verbs on Haiku by default. On
the first failure it escalates once to Sonnet, which is better at repair and
indirection; the tier that produced the result is reported. What comes back is a
short structured report — pass/fail, one-paragraph summary, evidence lines,
turns, token usage — not a transcript. With `--save <name>` the actions actually
taken are synthesized into `flows/<name>.flow.ts` using replay-stable targets
(testids and accessible names, never refs), so the next run is deterministic.

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
output, `--timeout <ms>` to override the 5000ms default on click, fill, select,
wait and expect. `bx help` prints the full verb list.

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
