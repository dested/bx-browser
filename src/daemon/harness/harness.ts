// Browser-side half of the recording pipeline.
//
// video-to-prompt is browser-only by design — it decodes through <video>,
// canvas and OfflineAudioContext — so bx runs it inside the browser it already
// controls rather than porting it. This file is bundled to dist/harness.js and
// served at /harness.js; it talks to the daemon over the /harness/* routes.
//
// Browser globals only: no node:*/Bun imports may appear here or the bundle
// will not run in the page.

import {
  buildManifestTxt,
  buildRecordingJson,
  buildReport,
  buildTranscriptTxt,
  distill,
  recDirName,
} from "video-to-prompt";
import type { StageProgress, TranscriptSegment } from "video-to-prompt";

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
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  // A rejected write would otherwise vanish and the package would ship short.
  if (!res.ok) throw new Error(`POST ${path} failed: HTTP ${res.status}`);
}

async function run(): Promise<void> {
  log("fetching recording…");
  const meta = parseMeta(await (await fetch("/harness/meta")).json());
  const blob = await (await fetch("/harness/video")).blob();
  const file = new File([blob], `${meta.title}.webm`, { type: "video/webm" });
  log(`video ${(blob.size / 1_000_000).toFixed(1)}MB, ${meta.segments.length} transcript lines`);

  const result = await distill([{ file }], {
    title: meta.title,
    onProgress: (p) => log(progressText(p)),
  });

  // The action log is grafted on after the fact rather than passed as a
  // `transcriber`: distill only calls one when `decodeMono` yields audio, and a
  // Playwright recording has no audio track — the transcriber would never run.
  // These four builders are exported for exactly this kind of re-derivation.
  const rebuilt = new Map<string, string>();
  if (meta.segments.length > 0) {
    for (const take of result.takes) {
      take.meta.transcript = meta.segments;
      take.meta.transcriber = "bx-action-log";
    }
    for (const take of result.takes) {
      const dir = recDirName(take.index);
      rebuilt.set(`${dir}/transcript.txt`, buildTranscriptTxt(take.meta));
      rebuilt.set(`${dir}/recording.json`, buildRecordingJson(result.session, take));
    }
    rebuilt.set("report.md", buildReport(result.session, result.takes));
    rebuilt.set("MANIFEST.txt", buildManifestTxt(result.session, result.takes));
    log(`grafted ${meta.segments.length} action-log lines into the transcript`);
  }

  log(`writing ${result.files.length} files…`);
  for (const out of result.files) {
    const replacement = rebuilt.get(out.path);
    const bytes =
      replacement === undefined
        ? new Uint8Array(await out.blob.arrayBuffer())
        : new TextEncoder().encode(replacement);
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
