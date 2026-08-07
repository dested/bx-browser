// Recording + video-to-prompt harness. Stub: the real implementation replaces
// this file wholesale. Signatures are the ones daemon.ts/session.ts compile
// against, so the swap is drop-in.

import type { RecordStartResult, RecordStopResult } from "../protocol.ts";

export function recordingSlug(): string | null {
  return null;
}

export async function recordStart(_session: unknown, _slug: string): Promise<RecordStartResult> {
  throw { code: "internal", message: "recording not built yet" };
}

export async function recordStop(_session: unknown, _outDir: string): Promise<RecordStopResult> {
  throw { code: "internal", message: "recording not built yet" };
}

/** Keyed by full pathname (e.g. "/harness", "/harness/video"). */
export const harnessRoutes: Record<string, (req: Request) => Promise<Response>> = {};
