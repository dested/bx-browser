// Keeps Chrome from probing the Windows account password on launch.
//
// On Windows, Chrome checks whether the OS account has a blank password by
// calling LogonUser(<user>, ".", "") — an interactive logon with an empty
// password. It caches the answer in the user-data-dir's `Local State` under
// password_manager.{os_password_blank, os_password_last_changed} and only
// re-probes when that cache is missing or the password's last-change time
// moved. Every bx profile is its own user-data-dir, so every fresh profile
// cost one failed logon (Security 4625, C000006A). Enough profiles launched
// inside the lockout window locks the Windows account — which is exactly what
// happened on 2026-09-29 (and blocked RDP with it).
//
// Fix: before launch, copy the already-computed answer from a Local State that
// has it (the user's real Chrome first, then any other bx profile) into this
// profile's Local State, so Chrome sees a warm cache and never calls LogonUser.
// Node runtime only (node:* APIs) — see daemon.ts.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const LOCAL_STATE = "Local State";

const CachedCheckSchema = z.object({
  os_password_blank: z.boolean(),
  os_password_last_changed: z.string().regex(/^\d+$/),
});
type CachedCheck = z.infer<typeof CachedCheckSchema>;

const JsonObjectSchema = z.record(z.string(), z.unknown());
type JsonObject = z.infer<typeof JsonObjectSchema>;

function readJsonObject(file: string): JsonObject | null {
  try {
    const parsed = JsonObjectSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function cachedCheckIn(file: string): CachedCheck | null {
  const state = readJsonObject(file);
  if (!state) return null;
  const parsed = CachedCheckSchema.safeParse(state["password_manager"]);
  return parsed.success ? parsed.data : null;
}

/** The real Chrome's answer wins: it re-probes itself after a password change. */
function findCachedCheck(profilesRoot: string, self: string): CachedCheck | null {
  const localAppData = process.env["LOCALAPPDATA"];
  if (localAppData !== undefined) {
    const real = cachedCheckIn(path.join(localAppData, "Google", "Chrome", "User Data", LOCAL_STATE));
    if (real) return real;
  }
  let entries: string[];
  try {
    entries = readdirSync(profilesRoot);
  } catch {
    return null;
  }
  for (const name of entries) {
    const dir = path.join(profilesRoot, name);
    if (dir === self) continue;
    const found = cachedCheckIn(path.join(dir, LOCAL_STATE));
    if (found) return found;
  }
  return null;
}

/**
 * Seeds `<profileDir>/Local State` with the cached blank-password answer.
 * Returns a short note for the daemon log. Never throws: a failure here must
 * not block the launch, it only means Chrome may probe once.
 */
export function seedOsPasswordCheck(profileDir: string): string {
  if (process.platform !== "win32") return "os-password seed: n/a (not windows)";
  try {
    const cached = findCachedCheck(path.dirname(profileDir), profileDir);
    if (!cached) return "os-password seed: no cached answer found — Chrome may probe the account once";

    const file = path.join(profileDir, LOCAL_STATE);
    const state: JsonObject = existsSync(file) ? (readJsonObject(file) ?? {}) : {};
    const current = CachedCheckSchema.safeParse(state["password_manager"]);
    if (
      current.success &&
      current.data.os_password_blank === cached.os_password_blank &&
      current.data.os_password_last_changed === cached.os_password_last_changed
    ) {
      return "os-password seed: already current";
    }

    const existingPm = JsonObjectSchema.safeParse(state["password_manager"]);
    state["password_manager"] = {
      ...(existingPm.success ? existingPm.data : {}),
      os_password_blank: cached.os_password_blank,
      os_password_last_changed: cached.os_password_last_changed,
    };
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(file, JSON.stringify(state));
    return "os-password seed: written";
  } catch (err) {
    return `os-password seed: failed (${String(err)}) — Chrome may probe the account once`;
  }
}
