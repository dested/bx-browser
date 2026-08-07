// Browser-side half of the recording pipeline.
//
// video-to-prompt is browser-only by design — it decodes through <video>,
// canvas and OfflineAudioContext — so bx runs it inside the browser it already
// controls rather than porting it. This file is bundled to dist/harness.js and
// served at /harness.js; it talks to the daemon over the /harness/* routes.
//
// Browser globals only: no node:*/Bun imports may appear here or the bundle
// will not run in the page.

import { distill } from "video-to-prompt";
import type { StageProgress, Transcriber, TranscriptSegment } from "video-to-prompt";

interface HarnessMeta {
  title: string;
  segments: TranscriptSegment[];
}

const logEl = document.getElementById("log");

function log(msg: string): void {
  if (logEl) logEl.textContent += `${msg}\n`;
}

/** Narrows the /harness/meta payload without trusting it — no casts. */
function parseMeta(value: unknown): HarnessMeta {
  if (typeof value !== "object" || value === null || !("title" in value) || !("segments" in value)) {
    throw new Error("bad /harness/meta payload");
  }
  const { title, segments } = value;
  if (typeof title !== "string" || !Array.isArray(segments)) {
    throw new Error("bad /harness/meta payload");
  }
  const parsed: TranscriptSegment[] = [];
  for (const entry of segments) {
    if (typeof entry !== "object" || entry === null) continue;
    if (!("t" in entry) || !("text" in entry)) continue;
    const { t, text } = entry;
    if (typeof t === "number" && typeof text === "string") parsed.push({ t, text });
  }
  return { title, segments: parsed };
}

/** btoa over a whole recording would blow the argument limit; go in slices. */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function progressText(p: StageProgress): string {
  // pct is 0..1, and -1 means the stage cannot report a fraction.
  return p.pct < 0 ? `${p.stage} …` : `${p.stage} ${Math.round(p.pct * 100)}%`;
}

async function post(path: string, body?: unknown): Promise<void> {
  await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

async function run(): Promise<void> {
  log("fetching recording…");
  const meta = parseMeta(await (await fetch("/harness/meta")).json());
  const blob = await (await fetch("/harness/video")).blob();
  const file = new File([blob], `${meta.title}.webm`, { type: "video/webm" });
  log(`video ${(blob.size / 1_000_000).toFixed(1)}MB, ${meta.segments.length} transcript lines`);

  // bx's action log is the narration: the recording has no audio track, so the
  // "transcriber" ignores the decoded samples and returns the log verbatim.
  const transcriber: Transcriber | undefined =
    meta.segments.length > 0 ? { id: "bx-action-log", run: async () => meta.segments } : undefined;

  const result = await distill([{ file }], {
    title: meta.title,
    transcriber,
    onProgress: (p) => log(progressText(p)),
  });

  log(`writing ${result.files.length} files…`);
  for (const out of result.files) {
    const bytes = new Uint8Array(await out.blob.arrayBuffer());
    await post("/harness/result", { path: out.path, base64: toBase64(bytes) });
  }

  log("done");
  await post("/harness/done");
}

run().catch(async (err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  log(`ERROR: ${message}`);
  await post("/harness/error", { message });
  throw err;
});
