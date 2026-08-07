---
name: bx
description: "Drive, verify, and record web apps through the bx CLI (token-budgeted browser automation). Use INSTEAD of browser MCP tools (claude-in-chrome/computer-use) whenever the task is: open a page, click through a UI, fill forms, verify a fix or behavior, capture console/network errors, record a workflow, or run/author a regression flow. Trigger on: 'open the app', 'click through', 'verify in the browser', 'check the console', 'record this flow', URLs of local dev servers."
---

# bx — browser automation as a CLI

A background daemon owns a real Chrome with a persistent profile (logins survive
between sessions). Every verb is a plain Bash call against it — no tool schemas,
no screenshot loop. Output is budgeted at the source (`els` ~800 tokens, `text`
~2000, console/network 30 entries), so never ration `bx els`. Act on text, not
pixels; screenshot only when the question is genuinely visual.

## Golden path

```bash
bx open https://myapp.localhost      # navigates, prints title + numbered elements
bx els                               # [1] link "Home"  [3] button "Save changes"
bx click 3                           # act on the ref
bx fill 5 "me@example.com"
bx expect text "Saved"               # exit 1 if it fails
```

Refs are per-scan and go stale by design: after navigation, re-run `bx els`
before using numbers — or pass text (`bx click "Save changes"`), which survives
re-renders.

**Target syntax** (auto-detected): `3` → ref from the last `els`; `#id`,
`.class`, `[attr]`, `//xpath`, `css=`, `xpath=` → selector; anything else →
text, matched in order against `data-testid`, role+name, label, placeholder,
visible text.

## Commands

| Verb | Syntax | Notes |
| --- | --- | --- |
| open | `bx open <url>` | navigate; prints title + element list |
| els | `bx els [--all] [--filter <text>]` | numbered interactive elements; `--all` lifts the 100-element cap |
| click | `bx click <target>` | auto-waits for actionability |
| fill | `bx fill <target> <value>` | clears then types |
| select | `bx select <target> <value>` | option value or label |
| press | `bx press <key>` | `Enter`, `Control+a`, … |
| wait | `bx wait <text\|selector\|ms>` | number = sleep, else wait until visible |
| expect | `bx expect text\|url\|visible\|not-visible <value>` | exit code 1 on failure |
| text | `bx text [selector]` | visible text, ~2000-token cap |
| console | `bx console [--all] [--filter <re>]` | errors + warnings by default |
| net | `bx net [--failed] [--filter <re>]` | requests; `--failed` = status ≥ 400 / aborted |
| snap | `bx snap [path] [--full]` | downscaled PNG under `~/.bx/snaps/`; prints the path |
| js | `bx js <expression>` | evaluates in the page, returns JSON |
| nav | `bx back` / `bx reload` | |
| tabs | `bx tabs` / `bx tab <n>` / `bx tab new [url]` / `bx tab close` | |
| run | `bx run <flow-file> [--record]` | replay a typed flow; zero model tokens |
| agent | `bx agent "<instruction>" [--model haiku\|sonnet] [--save <name>]` | delegate; returns a short report |
| record | `bx record start <slug>` / `bx record stop` | video → keyframe package |
| admin | `bx status` / `bx profiles` / `bx stop` | daemon lifecycle |

Global flags: `--profile <name>` (default `default`), `--headless`, `--json`,
and `--timeout <ms>` (overrides the 5000ms default on click, fill, select, wait
and expect). The daemon starts on first use, one per profile.

## Delegate multi-step work

For anything phrased as a natural-language task — "log in and check the invoice
list loads", "add an item to the cart and verify the total" — **prefer**:

```bash
bx agent "log in as demo@acme.test and verify the invoice list loads" --save invoices
```

It runs on a cheap model (Haiku, escalating once to Sonnet on failure) and hands
back a ~300-token pass/fail report with evidence — far cheaper than you issuing
twenty commands and reading twenty outputs. `--save <name>` writes the actions
taken to `flows/<name>.flow.ts`, replayable forever at zero token cost via
`bx run flows/invoices.flow.ts`. Drive step by step yourself only for short
exploratory poking.

## Verify a fix

```bash
bx expect text "Order placed"    # or: expect url /orders/, expect visible ...
bx console                       # errors + warnings only
bx net --failed                  # 4xx/5xx/aborted
```

That trio is the default verification. Reach for `bx snap` only when the claim
is about appearance (layout, spacing, a chart) — it prints a path you then
`Read` as an image.

## Record a walkthrough

```bash
bx record start checkout-bug
# …drive, or bx run flows/checkout.flow.ts --record…
bx record stop
```

Produces `recordings/<slug>/`: deduped keyframes, 3×3 contact sheets, and a
`report.md` narrated by the action log. Point the user at `report.md`; read the
contact sheets yourself if you need to see what happened.

## Notes

- Non-zero exit means failure: 1 = command/expect, 2 = usage, 3 = daemon/browser.
  Read the error text — unresolved targets list near-matches.
- If a target won't resolve, run `bx els --filter <word>` rather than guessing.
- First run of a profile: the user signs in once by hand; state persists.

Install: copy this folder to `~/.claude/skills/bx/`.
