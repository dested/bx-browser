// The /cmd response envelope, checked by hand (no zod: the CLI loads this on
// every call). The daemon's /argv route runs its in-process results through
// the same check, so both paths print exactly what the CLI would.

import type { BxError, El } from "../protocol.ts";

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const ERROR_CODES: ReadonlySet<string> = new Set<BxError["code"]>([
  "target_not_found",
  "stale_ref",
  "timeout",
  "no_page",
  "not_recording",
  "already_recording",
  "browser_launch_failed",
  "browser_dead",
  "deadline",
  "ambiguous",
  "bad_request",
  "internal",
]);

function isErrorCode(v: unknown): v is BxError["code"] {
  return typeof v === "string" && ERROR_CODES.has(v);
}

function toEl(v: unknown): El | null {
  if (!isRecord(v)) return null;
  const { ref, tag, role, name, state, testid, id } = v;
  if (typeof ref !== "number" || typeof tag !== "string" || typeof role !== "string") return null;
  if (typeof name !== "string" || !Array.isArray(state)) return null;
  return {
    ref,
    tag,
    role,
    name,
    state: state.filter((x): x is string => typeof x === "string"),
    testid: typeof testid === "string" ? testid : undefined,
    id: typeof id === "string" ? id : undefined,
  };
}

export type Envelope =
  | { ok: true; data: unknown; relaunched: boolean }
  | { ok: false; error: BxError };

export function toEnvelope(v: unknown): Envelope | null {
  if (!isRecord(v)) return null;
  if (v.ok === true && "data" in v) return { ok: true, data: v.data, relaunched: v.relaunched === true };
  if (v.ok !== false || !isRecord(v.error)) return null;
  const { code, message, nearMatches } = v.error;
  if (!isErrorCode(code) || typeof message !== "string") return null;
  const error: BxError = { code, message };
  if (Array.isArray(nearMatches)) {
    error.nearMatches = nearMatches.map(toEl).filter((el): el is El => el !== null);
  }
  return { ok: false, error };
}
