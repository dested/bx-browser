# Claude-in-Chrome live measurement (blog source data)

- **Date:** 2026-08-06
- **Status:** done
- **Type:** notes
- **What:** Measured old-way session against the TaskBox fixture for the blog comparison.

Task (identical to the bx agent bench): open fixture, log in, go to Settings,
toggle dark mode, verify "Dark mode on".

## What happened (driven live via claude-in-chrome MCP, Fable as driver)

- 14 tool calls total; login succeeded, **task failed** — Settings navigation
  never landed despite 3 attempts (2 coordinate clicks, 1 ref click).
- 2× CDP `Page.captureScreenshot` timeouts (30s each) — 60s wall wasted.
- Coordinate scale mismatch discovered: screenshots 1568px wide vs viewport
  1512px (~3.7% drift) — clicks computed from screenshot pixels land off-target.
- After the first CDP timeout, clicks reported success but had no effect
  (degraded session state — the failure a user ends by restarting the tab).
- ~3.5 min wall clock, task incomplete.

## Token accounting (this session, conservative)

- 4 screenshots @ 1568×776 jpeg ≈ 1,620 img tokens each ≈ **6,500 tokens**
  (one screenshot purely wasted discovering a silently lost click).
- read_page on the tiny fixture: ~120 tokens (real apps: 5–30k — fixture is
  a best case for the old way).
- Tool-result text + context: ~1,500 tokens.
- Total ≈ **8,000+ tokens of premium-model context** ($10/MTok input tier),
  plus the driver model's reasoning between every action.
- Tool schemas: 6 of ~24 chrome MCP tools loaded on demand ≈ 2,800 tokens of
  schema text (measured from the loaded definitions; a full always-on MCP
  server loads all of them).

## Same task, bx (measured in bench-results.json)

- `bx agent` on Haiku: **PASS**, 19 turns, 21.0s, 32,499 tokens on the CHEAP
  model ($0.0369 API-equivalent; ~zero Opus/Fable context consumed — the main
  session reads a ~300-token report).
- Flow replay after `--save`: **1.2s, 0 model tokens**, deterministic.
- Observation: els = 42 tokens vs screenshot = 1,620 tokens (~39×) vs raw DOM
  dump = 2,564 tokens (61×).

## Honest caveats for the blog

- The fixture is tiny and static — read_page's 120 tokens is the old way's
  best case; production apps are 5–30k.
- The old-way session was driven efficiently (no exploratory wandering); real
  sessions are worse.
- bx's numbers exclude the one-time cost of authoring the flow/instruction.
- CDP flakiness varies by machine/day; two timeouts in one 14-call session is
  one sample, not a rate estimate. But the coordinate-scale drift is
  structural, not luck.
