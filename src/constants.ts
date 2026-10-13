// Zod-free constants shared by the CLI hot path and the daemon. protocol.ts
// re-exports every one of them; import from here only where load time matters
// (the CLI's per-call startup), so a `bx` call never pays for building the
// protocol's zod schemas.

export const BX_DIR_NAME = ".bx"; // under os.homedir()
export const RUN_DIR = "run"; // ~/.bx/run/<profile>.json
export const PROFILES_DIR = "profiles"; // ~/.bx/profiles/<name> (chrome user-data-dir)
export const SNAPS_DIR = "snaps"; // ~/.bx/snaps/<ts>.png
export const LOGS_DIR = "logs"; // ~/.bx/logs/<profile>.log (daemon stdout/stderr)

// Who sent a /cmd: see ClientTag in protocol.ts.
export const CLIENT_HEADER = "x-bx-client";

// Per-command deadline, sent as a request header (not part of Cmd): the
// daemon answers `deadline` when a command runs longer. Default 10 s, clamped
// to 1 s..10 min; drive gets its own timeoutMs + 5 s; recordings are exempt.
export const DEADLINE_HEADER = "x-bx-deadline-ms";
export const DEFAULT_DEADLINE_MS = 10_000;
