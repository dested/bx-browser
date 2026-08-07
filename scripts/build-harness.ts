// Bundles the harness page's browser-side source into dist/harness.js.
//
// This runs under Bun (for Bun.build), but the daemon runs under Node — so the
// daemon shells out to this script rather than importing it.
//
//   bun scripts/build-harness.ts

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const ENTRY = path.join(repoRoot, "src", "daemon", "harness", "harness.ts");
const OUT_DIR = path.join(repoRoot, "dist");
const OUT_FILE = path.join(OUT_DIR, "harness.js");
const DEP_DIR = path.join(repoRoot, "node_modules", "video-to-prompt");
const DEP_ENTRY = path.join(DEP_DIR, "dist", "index.js");

/**
 * video-to-prompt is a git dependency whose package.json points main/types into
 * `dist/`, but git installs ship only `src/` — nothing runs its build, so the
 * package is unresolvable as installed. Build it in place on first use.
 *
 * `--rootDir src` is required: the dep's tsconfig was written for TS 5.x and
 * our TS 7 rejects it with TS5011 otherwise. Its build config already sets
 * `declaration: true`, and our `skipLibCheck` keeps the emitted .d.ts out of
 * our stricter program (its source does not survive noUncheckedIndexedAccess).
 */
async function ensureDepBuilt(): Promise<void> {
  if (existsSync(DEP_ENTRY)) return;

  console.log("video-to-prompt ships no dist — building it in place");
  const proc = Bun.spawn(["bun", "x", "tsc", "-p", "tsconfig.build.json", "--rootDir", "src"], {
    cwd: DEP_DIR,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;

  if (exitCode !== 0 || !existsSync(DEP_ENTRY)) {
    const stderr = await new Response(proc.stderr).text();
    const stdout = await new Response(proc.stdout).text();
    const tail = `${stderr}${stdout}`.trim().split("\n").slice(-5).join("\n");
    throw new Error(
      `video-to-prompt has no dist and in-place build failed: ${tail} — build it manually in the video-to-prompt repo`,
    );
  }
  console.log("video-to-prompt built");
}

export async function buildHarness(): Promise<string> {
  await ensureDepBuilt();

  const result = await Bun.build({
    entrypoints: [ENTRY],
    target: "browser",
    format: "esm",
    minify: false,
    outdir: OUT_DIR,
  });

  if (!result.success) {
    throw new Error(`harness bundle failed:\n${result.logs.map((l) => String(l)).join("\n")}`);
  }
  return OUT_FILE;
}

if (import.meta.main) {
  const out = await buildHarness();
  console.log(`harness bundled → ${out}`);
}
