export type Tone = "plain" | "ok" | "dim" | "accent" | "fail";

export type DemoLine =
  | { kind: "cmd"; text: string }
  | { kind: "out"; text: string; tone?: Tone }
  | { kind: "blank" };

export type Demo = {
  id: string;
  label: string;
  blurb: string;
  badge: string;
  /** Shown under the terminal once the output has finished printing. */
  note: string;
  lines: DemoLine[];
};

export const demos: [Demo, ...Demo[]] = [
  {
    id: "inspect",
    label: "Inspect a page",
    blurb: "One command, one look at the page.",
    badge: "42 tokens",
    note: "↑ that stdout is everything the model sees",
    lines: [
      { kind: "cmd", text: "bx open https://myapp.localhost" },
      { kind: "out", text: "✓ Acme — Sign in — https://myapp.localhost/login", tone: "ok" },
      { kind: "blank" },
      { kind: "out", text: '[1] textbox "Email"' },
      { kind: "out", text: '[2] textbox "Password"' },
      { kind: "out", text: '[3] button "Sign in"' },
    ],
  },
  {
    id: "verify",
    label: "Verify a fix",
    blurb: "The whole check is three commands and three lines back.",
    badge: "no screenshot needed",
    note: "↑ three exit-coded checks replace a screenshot",
    lines: [
      { kind: "cmd", text: 'bx expect text "Saved"' },
      { kind: "out", text: '✓ expect text "Saved"', tone: "ok" },
      { kind: "blank" },
      { kind: "cmd", text: "bx console" },
      { kind: "out", text: "(none)", tone: "dim" },
      { kind: "blank" },
      { kind: "cmd", text: "bx net --failed" },
      { kind: "out", text: "(none)", tone: "dim" },
    ],
  },
  {
    id: "agent",
    label: "Delegate to Haiku",
    blurb: "Hand the task down. Read the verdict, not the transcript.",
    badge: "your main session read ~300 tokens",
    note: "↑ your context gets this line, not 30 turns",
    lines: [
      {
        kind: "cmd",
        text: 'bx agent "log in and verify the invoice list loads" --save invoices',
      },
      { kind: "out", text: "· haiku · driving", tone: "dim" },
      { kind: "out", text: "  open → fill → fill → click → els → click → expect", tone: "dim" },
      { kind: "out", text: "  ✓ invoice list rendered — 12 rows, no console errors", tone: "plain" },
      { kind: "out", text: "  saved flows/invoices.flow.ts", tone: "plain" },
      { kind: "blank" },
      {
        kind: "out",
        text: "tier=haiku turns=14 wall=25.9s cost=$0.062 — PASS",
        tone: "accent",
      },
    ],
  },
  {
    id: "replay",
    label: "Replay a flow",
    blurb: "Once a path works it never needs a model again.",
    badge: "0 model tokens",
    note: "↑ no model was involved",
    lines: [
      { kind: "cmd", text: "bx run flows/invoices.flow.ts" },
      { kind: "out", text: "• open (52ms)", tone: "dim" },
      { kind: "out", text: "• fill Email (38ms)", tone: "dim" },
      { kind: "out", text: "• fill Password (34ms)", tone: "dim" },
      { kind: "out", text: "• click Sign in (187ms)", tone: "dim" },
      { kind: "out", text: "• expectText Dashboard (41ms)", tone: "dim" },
      { kind: "out", text: "• click Invoices (176ms)", tone: "dim" },
      { kind: "out", text: "• waitText Invoice #1041 (122ms)", tone: "dim" },
      { kind: "out", text: "• expectText Invoice #1041 (29ms)", tone: "dim" },
      { kind: "out", text: "• snap (511ms)", tone: "dim" },
      { kind: "blank" },
      { kind: "out", text: "PASS invoices (1190ms, 9 steps)", tone: "accent" },
    ],
  },
];
