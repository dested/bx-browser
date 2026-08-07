// Flip a settings toggle and prove it took effect — the shape of a regression
// flow: navigate, act, assert, and capture one frame for the visual record.
//
//   bx run flows/examples/verify-toggle.flow.ts
//   bx run flows/examples/verify-toggle.flow.ts --record
//
// Targets are strings: a selector when it starts with # . [ // css= xpath=,
// otherwise text — matched against data-testid, then role+name, label,
// placeholder, and finally visible text. Refs ([3] from `bx els`) are
// deliberately NOT used in flows; they go stale between sessions.
//
// "bx/flow" resolves when bx is linked globally (`bun link bx` in a consumer
// repo) or when the flow lives inside this repo.

import { flow } from "bx/flow";

export default flow("verify-toggle", async (b) => {
  await b.open("https://myapp.localhost");
  await b.click("Settings");

  // Matches <button data-testid="dark-mode">.
  await b.click("dark-mode");
  await b.expectText("Dark mode on");

  // snap() returns the written path; the runner prints it either way.
  await b.snap();
});
