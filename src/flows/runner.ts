// Replays a flow file. Zero model tokens: import the module, run its steps,
// print a one-line verdict. On failure, surface the console errors that most
// often explain it.

import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { CliError, cmd, formatConsoleEntry } from "../client.ts";
import type { ConsoleEntry } from "../protocol.ts";
import { FlowAssertionError, FlowContext } from "./api.ts";
import type { Flow } from "./api.ts";

const FAILURE_CONSOLE_LINES = 5;

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
