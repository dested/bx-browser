// video-to-prompt writes its report for a narrated human walkthrough: "spoken
// lines", "the speaker", "speech recognition mangles…". A bx recording has no
// voice; its lines are bx's own action log, exact and machine-written. That
// wording would mislead the agent reading the report, so every text file the
// harness writes goes through here first.
//
// Pure string work, browser-safe (bundled into dist/harness.js) and
// unit-tested in tests/record.test.ts.

const HEAD =
  "> **You are reading a bx recording: one browser tab, captured while bx commands drove it (an agent or a flow, not a person talking).**\n" +
  "> Everything below sits on one timeline, in the order it happened. **Read the images:**\n" +
  "> they are the primary evidence; the text lines are bx's action log, one line per command.\n" +
  "> Every path is relative to this recording's folder. Wherever this report caps or thins\n" +
  "> what it shows you it prints the count — when you see one, you are looking at a subset.";

const PARTS =
  "> Read it in this order: first the **contact sheets** — nine keyframes per image, in order,\n" +
  "> covering the *whole* recording at a fraction of the tokens — then the flow below, the same\n" +
  "> recording as text. A full still is inlined only where an action points at something; every\n" +
  "> other keyframe is listed by filename (`rec-NN/frames/NN-mmss.jpg`), and the mmss in a filename\n" +
  "> is time within `video.webm`. Each action-log line is stamped when its bx command finished and\n" +
  "> names the frames around it — trust that range over the stamp.";

const CAVEAT = "> The text lines are bx's action log: what each bx command did, written by bx itself — exact, not transcribed.";

/** [pattern, replacement], applied in order. */
const REWRITES: [RegExp, string | ((match: string) => string)][] = [
  // The two preamble blocks, whole.
  [/> \*\*You are reading a walkthrough[\s\S]*?the rest is in the walkthrough\./, HEAD],
  [/> The \*\*walkthrough\*\* is a narrated screen recording[\s\S]*?is asked of you\./, PARTS],
  // The transcript caveat (each variant), as one line.
  [/> The speaker read this transcript back[^\n]*\n/g, `${CAVEAT}\n`],
  [/> The transcript is machine-transcribed[^\n]*\n(> Speech recognition[^\n]*\n)?(> Where a word contradicts[^\n]*\n)?/g, `${CAVEAT}\n`],
  [/^# Walkthrough — /m, "# Recording — "],
  // The video is video.webm at the package root; the harness never writes a copy.
  [/rec-\d+\/walkthrough\.webm/g, "video.webm"],
  [/\bwalkthrough\.webm\b/g, "video.webm"],
  [/\bspoken lines?\b/g, (match) => match.replace("spoken", "action-log")],
  [/the moments the narration is pointing at/g, "the moments an action points at"],
  [/nothing said over them/g, "no action logged over them"],
  [/\(none — no narration was captured\)/g, "(none — no actions were logged)"],
  [/\(no narration\)/g, "(no actions)"],
  [/ — NOT checked by the speaker; treat wording as approximate/g, " — exact"],
  [/ — read back and corrected by the speaker/g, " — exact"],
  [/line stamps are where the speaker started/g, "line stamps are when the bx command finished"],
  // Anything the library adds later: never let these words through.
  [/\bspeakers?\b/gi, "operator"],
  [/\bspoken\b/gi, "logged"],
  [/\bspeech recognition\b/gi, "the action log"],
];

/** Rewrites one text file of the package for a bx (action-log) recording. */
export function actionLogWording(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REWRITES) {
    out = typeof replacement === "string" ? out.replace(pattern, replacement) : out.replace(pattern, replacement);
  }
  return out;
}

/** The files whose text is rewritten; everything else (images, json) passes as is. */
export function isRewordedFile(file: string): boolean {
  return file === "report.md" || file === "MANIFEST.txt" || /^rec-\d+\/transcript\.txt$/.test(file);
}

/** Video copies the library adds to its file set; the package already has video.webm. */
export function isVideoCopy(file: string): boolean {
  return file.endsWith(".webm");
}
