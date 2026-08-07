// Replays a flow file. Zero model tokens: import the module, run its steps,
// print a one-line verdict. On failure, surface the console errors that most
// often explain it.

import { plugin } from "bun";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { CliError, cmd, formatConsoleEntry } from "../client.ts";
import type { ConsoleEntry } from "../protocol.ts";
import { FlowAssertionError, FlowContext } from "./api.ts";
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

export async function runFlow(
  file: string,
  opts: { profile: string; record: boolean },
): Promise<boolean> {
  const abs = path.resolve(process.cwd(), file);
  aliasFlowImport(abs);
  const mod: unknown = await import(pathToFileURL(abs).href);
  const flow = typeof mod === "object" && mod !== null ? Reflect.get(mod, "default") : undefined;
  if (!isFlow(flow)) {
    throw new CliError(2, `not a flow file — default-export flow(name, fn): ${abs}`);
  }

  const slug = slugify(flow.name);
  let recording = false;
  if (opts.record) {
    const res = await cmd(opts.profile, { cmd: "recordStart", slug });
    if (!res.ok) throw new CliError(1, `could not start recording: ${res.error.message}`);
    recording = true;
  }

  let lastLabel = "start";
  let steps = 0;
  const ctx = new FlowContext(opts.profile, {
    onStep(label, ms) {
      steps++;
      lastLabel = label;
      process.stdout.write(`  • ${label} (${ms}ms)\n`);
    },
  });

  const started = Date.now();
  try {
    await flow.fn(ctx);
    process.stdout.write(`PASS ${flow.name} (${Date.now() - started}ms, ${steps} steps)\n`);
    return true;
  } catch (err) {
    const message = err instanceof FlowAssertionError ? err.detail : errorMessage(err);
    process.stdout.write(`FAIL ${flow.name} at ${lastLabel}: ${message}\n`);
    await printConsoleErrors(opts.profile);
    return false;
  } finally {
    if (recording) {
      const outDir = path.resolve(process.cwd(), "recordings", slug);
      const res = await cmd(opts.profile, { cmd: "recordStop", outDir });
      if (!res.ok) process.stderr.write(`✗ recording: ${res.error.message}\n`);
      else process.stdout.write(`recording → ${outDir}\n`);
    }
  }
}

async function printConsoleErrors(profile: string): Promise<void> {
  const res = await cmd<ConsoleEntry[]>(profile, { cmd: "console" });
  if (!res.ok) return;
  const errors = res.data.filter((e) => e.level === "error" || e.level === "pageerror");
  for (const entry of errors.slice(-FAILURE_CONSOLE_LINES)) {
    process.stdout.write(`  ${formatConsoleEntry(entry)}\n`);
  }
}
