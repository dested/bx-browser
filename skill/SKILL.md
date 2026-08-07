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

## Reach for `bx agent` FIRST

For anything phrased as a task — "log in and check the invoice list", "add an
item and verify the total", "click through settings and confirm the toggle
sticks" — do NOT drive step by step. Delegate:

```bash
bx agent "log in as demo@acme.test and verify the invoice list loads" --save invoices
```

- Runs on **Haiku** (one-shot Sonnet escalation on failure) and returns a
  ~300-token pass/fail report with evidence. Ends with a trailer —
  `tier=haiku turns=14 wall=25.9s cost=$0.037` — quote it when reporting.
- `--opus` allows one FINAL escalation Sonnet → Opus 4.8. Complex flows only
  (long multi-page journeys, gnarly canvas work) — ~5× Sonnet cost. Don't pass
  it by default; add it when a Sonnet attempt already failed on a task that
  genuinely needs the extra reasoning. `--model opus` runs Opus directly.
- Typical real-app DOM task: 10–40 turns, 15–75s, $0.02–0.06. Measured 7/7
  correct on a production app. Canvas tasks run longer — raise the budget with
  `--max-turns 60` for multi-step game work.
- Every run writes a full turn-by-turn transcript to `~/.bx/agent-runs/` (path
  in the trailer); `--verbose` streams it live to stderr. A failed run's report
  says where it got stuck — read it before re-running.
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
| tabs | `bx tabs` / `bx tab <n>` / `bx tab new [url]` / `bx tab close` | |
| run | `bx run <flow.ts> [--record]` | replay a flow; zero model tokens |
| agent | `bx agent "<task>" [--model haiku\|sonnet\|opus] [--opus] [--save <n>] [--max-turns <n>] [--verbose]` | delegate |
| record | `bx record start <slug>` / `bx record stop` | video → narrated package |
| admin | `bx status` / `bx profiles` / `bx stop` | daemon lifecycle |

Global flags: `--profile <name>` (default `default`), `--headless`, `--json`
(includes an `ms` timing field), `--timeout <ms>`. `BX_TIMING=1` prints wall
time to stderr per command. The daemon starts on first use, one per profile.

## Canvas, games, non-semantic UIs

When there's no DOM to target, use coordinates — element-relative via `--in`
so positions mean "inside the canvas":

```bash
bx mouse click 200 150 --in "game-canvas"   # also: dblclick, move, down, up
bx drag 50 50 300 200 --in "game-canvas"    # mousedown → moves → mouseup
bx key down w                               # hold a key (WASD movement)
bx wait 500
bx key up w
bx wheel -120 --in "game-canvas"            # scroll/zoom
```

Pair with `bx js` to read game state the app exposes, and `bx snap` when the
claim is visual. These log to the action log and synthesize into flows like
every other verb.

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

Install: copy this folder to `~/.claude/skills/bx/`; `bun link` in the repo
puts `bx` on PATH.
