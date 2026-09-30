// Force `windowsHide: true` on every child process this daemon spawns.
//
// Playwright's recordVideo encoder (ffmpeg, a console app) is spawned inside
// playwright-core via `childProcess.spawn` with no `windowsHide`, so on Windows
// every `bx record` popped a console window that sat open for the whole
// recording. Playwright's bundle reads `spawn` through a live getter on the
// `child_process` exports object, so replacing the export here (imported first
// by daemon.ts) reaches that internal call. Must stay Node-runtime compatible:
// erasable TS only, no Bun.* APIs.

import { createRequire } from "node:module";
import type * as ChildProcess from "node:child_process";

if (process.platform === "win32") {
  const cp: typeof ChildProcess = createRequire(import.meta.url)("node:child_process");
  const original = cp.spawn;
  const hidden = function (this: unknown, ...args: unknown[]) {
    // spawn(command, args?, options?): options is the last plain object, if any.
    const last = args[args.length - 1];
    if (args.length >= 2 && last !== null && typeof last === "object" && !Array.isArray(last)) {
      args[args.length - 1] = { ...last, windowsHide: true };
    } else {
      args.push({ windowsHide: true });
    }
    return Reflect.apply(original, this, args);
  };
  Object.defineProperty(cp, "spawn", { value: hidden, writable: true, configurable: true, enumerable: true });
}
