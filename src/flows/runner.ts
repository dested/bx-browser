// Replays a flow file. Zero model tokens: import the module, run its steps in
// a tab of their own, print a one-line verdict. On failure, print the near
// matches, save a screenshot and an els dump beside the flow, and surface the
// tab's console errors that most often explain it.

import { plugin } from "bun";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { CliError, cmd, formatConsoleEntry, renderEl } from "../client.ts";
import { FlowAssertionError, FlowContext, FlowStepError } from "./api.ts";
import type { Flow } from "./api.ts";

const FAILURE_CONSOLE_LINES = 5;

// Flow files live in the user's project, where "bx/flow" (this package's
// exports map) does not resolve. Bun's runtime onResolve hook never sees bare
// specifiers (verified on 1.3.10 — only relative ones reach it), so the alias
// is applied when the flow module is loaded: its "bx/flow" import is rewritten
// to this file's sibling api.ts. Bun-only, which is how the CLI always runs.
const FLOW_API_PATH = path.join(import.meta.dir, "api.ts");
const FLOW_SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*)(["'])bx\/flow\2/g;
const LOADERS: Record<string, "ts" | "tsx" | "js" | "jsx"> = {
  ".ts": "ts", ".mts": "ts", ".cts": "ts", ".tsx": "tsx",
  ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "jsx",
};
const aliased = new Set<string>();

function escapeRegExp(s: string): string {
  return s.replace(/[\\^$*+?.()|[\]{}]/g, "\\$&");
}

// Registered per flow file so the hook never intercepts unrelated modules —
// an onLoad hook must return contents for everything its filter matches.
export function aliasFlowImport(abs: string): void {
  if (aliased.has(abs)) return;
  aliased.add(abs);
  const loader = LOADERS[path.extname(abs).toLowerCase()] ?? "ts";
  plugin({
    name: "bx-flow-alias",
    setup(build) {
      build.onLoad({ filter: new RegExp(`^${escapeRegExp(abs)}$`) }, async (args) => {
        const source = await Bun.file(args.path).text();
        const contents = source.replace(
          FLOW_SPECIFIER,
          (_match, lead: string) => `${lead}${JSON.stringify(FLOW_API_PATH)}`,
        );
        return { contents, loader };
      });
    },
  });
}

function isFlow(value: unknown): value is Flow {
  if (typeof value !== "object" || value === null) return false;
  return typeof Reflect.get(value, "name") === "string" &&
    typeof Reflect.get(value, "fn") === "function";
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "flow";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `<dir>/<name>` of a flow file minus `.flow.ts` (or its extension): failure artifacts sit beside it. */
export function failureBase(abs: string): string {
  const name = path.basename(abs).replace(/\.flow\.[cm]?[jt]sx?$/i, "").replace(/\.[cm]?[jt]sx?$/i, "");
  return path.join(path.dirname(abs), name);
}

export async function runFlow(
  file: string,
  opts: { profile: string; record: boolean; headless?: boolean },
): Promise<boolean> {
  const abs = path.resolve(process.cwd(), file);
  aliasFlowImport(abs);
  const mod: unknown = await import(pathToFileURL(abs).href);
  const flow = typeof mod === "object" && mod !== null ? Reflect.get(mod, "default") : undefined;
  if (!isFlow(flow)) {
    throw new CliError(2, `not a flow file — default-export flow(name, fn): ${abs}`);
  }

  const start = opts.headless === undefined ? undefined : { headless: opts.headless };
  const slug = slugify(flow.name);
  let recording = false;
  if (opts.record) {
    const res = await cmd(opts.profile, { cmd: "recordStart", slug }, start);
    if (!res.ok) throw new CliError(1, `could not start recording: ${res.error.message}`);
    recording = true;
  }

  let lastLabel = "start";
  let steps = 0;
  const ctx = new FlowContext(
    opts.profile,
    {
      onStep(label, ms) {
        steps++;
        lastLabel = label;
        process.stdout.write(`  • ${label} (${ms}ms)\n`);
      },
    },
    // A recording captures the tab the flow drives, which must be in front to paint.
    { headless: opts.headless, background: !opts.record },
  );

  const started = Date.now();
  try {
    await flow.fn(ctx);
    process.stdout.write(`PASS ${flow.name} (${Date.now() - started}ms, ${steps} steps)\n`);
    return true;
  } catch (err) {
    await reportFailure(ctx, flow.name, lastLabel, err, failureBase(abs));
    return false;
  } finally {
    if (recording) {
      const outDir = path.resolve(process.cwd(), "recordings", slug);
      const res = await cmd(opts.profile, { cmd: "recordStop", outDir });
      if (!res.ok) process.stderr.write(`✗ recording: ${res.error.message}\n`);
      else process.stdout.write(`recording → ${outDir}\n`);
    }
    // Only after recordStop: closing the tab first would drop its video.
    await ctx.close();
  }
}

async function reportFailure(ctx: FlowContext, name: string, label: string, err: unknown, base: string): Promise<void> {
  const message =
    err instanceof FlowAssertionError
      ? err.detail
      : err instanceof FlowStepError
        ? `${err.error.code}: ${err.error.message}`
        : errorMessage(err);
  process.stdout.write(`FAIL ${name} at ${label}: ${message}\n`);
  const near = err instanceof FlowStepError ? (err.error.nearMatches ?? []) : [];
  if (near.length > 0) {
    process.stdout.write("  near matches:\n");
    for (const el of near) process.stdout.write(`    ${renderEl(el)}\n`);
  }
  for (const saved of await ctx.captureFailure(base)) process.stdout.write(`  saved ${saved}\n`);
  for (const entry of (await ctx.consoleErrors()).slice(-FAILURE_CONSOLE_LINES)) {
    process.stdout.write(`  ${formatConsoleEntry(entry)}\n`);
  }
}
