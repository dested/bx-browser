import raw from "./compare.json";

export type EventKind = "cmd" | "out" | "say" | "err" | "note";

export type TimelineEvent = {
  at: number;
  kind: EventKind;
  text: string;
  tok: number;
};

export type Outcome = {
  status: string;
  at: number;
  wall: string;
  tokens: string;
  cost: string;
  detail: string;
};

export type Timeline = {
  title: string;
  driver: string;
  events: TimelineEvent[];
  outcome: Outcome;
  totalTokens: number;
};

/** Narrows the JSON's `string` back to the union without a cast. */
function toKind(value: string): EventKind {
  switch (value) {
    case "cmd":
    case "out":
    case "say":
    case "err":
    case "note":
      return value;
    default:
      return "note";
  }
}

type RawTimeline = (typeof raw)["oldway"];

function load(source: RawTimeline): Timeline {
  const events = source.events.map((e) => ({
    at: e.at,
    kind: toKind(e.type),
    text: e.text,
    tok: e.tok,
  }));
  return {
    title: source.title,
    driver: source.driver,
    events,
    outcome: source.outcome,
    totalTokens: events.reduce((sum, e) => sum + e.tok, 0),
  };
}

export const oldway = load(raw.oldway);
export const bx = load(raw.bx);

/**
 * Clock position of the first event whose text contains `needle`. Screen
 * changes are keyed off the transcript rather than guessed timings, so the
 * build breaks loudly if the captured data ever changes shape.
 */
export function eventTime(timeline: Timeline, needle: string): number {
  const hit = timeline.events.find((e) => e.text.includes(needle));
  if (!hit) throw new Error(`compare.json: no event matching "${needle}"`);
  return hit.at;
}

/** The whole race runs on one clock; the slow side sets its length. */
export const raceDuration = Math.max(oldway.outcome.at, bx.outcome.at) + 1500;
