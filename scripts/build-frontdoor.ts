// Builds bx.exe, the NativeAOT front door (dotnet/bx), and copies it to
// dist/bx.exe. Needs the .NET 10 SDK and the C++ build tools NativeAOT links
// with. Nothing here touches PATH or the global bx link.
//
//   bun scripts/build-frontdoor.ts

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const project = path.join(root, "dotnet", "bx", "bx.csproj");
const publishDir = path.join(root, "dotnet", "bx", "bin", "publish");
const dist = path.join(root, "dist");

if (process.platform !== "win32") {
  console.error("bx.exe is Windows-only; other platforms use the Bun CLI.");
  process.exit(2);
}

// The ILCompiler finds the linker through vcvarsall.bat, whose helpers call a
// bare `vswhere.exe`; without its folder on PATH that output lands in the
// linker's path and the link fails.
const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
const vswhereDir = path.join(programFilesX86, "Microsoft Visual Studio", "Installer");
const env = { ...process.env, PATH: `${process.env.PATH ?? ""}${path.delimiter}${vswhereDir}` };

const started = performance.now();
const result = spawnSync(
  "dotnet",
  ["publish", project, "-c", "Release", "-r", "win-x64", "-o", publishDir, "--nologo"],
  { stdio: "inherit", windowsHide: true, env },
);
if (result.error !== undefined) {
  console.error(`can't run dotnet: ${result.error.message}`);
  process.exit(3);
}
if (result.status !== 0) process.exit(result.status ?? 1);

const built = path.join(publishDir, "bx.exe");
fs.mkdirSync(dist, { recursive: true });
const target = path.join(dist, "bx.exe");
fs.copyFileSync(built, target);
const kb = Math.round(fs.statSync(target).size / 1024);
console.log(`✓ ${target} (${kb} KB, ${((performance.now() - started) / 1000).toFixed(1)}s)`);
