// Sign in to an app and confirm the dashboard rendered.
//
//   bx run flows/examples/login.flow.ts
//   bx run flows/examples/login.flow.ts --record   # also capture a video package
//
// Targets are strings: a selector when it starts with # . [ // css= xpath=,
// otherwise text — matched against data-testid, then role+name, label,
// placeholder, and finally visible text. Refs ([3] from `bx els`) are
// deliberately NOT used in flows; they go stale between sessions.
//
// "bx/flow" resolves when bx is linked globally (`bun link bx` in a consumer
// repo) or when the flow lives inside this repo.

import { flow } from "bx/flow";

export default flow("login", async (b) => {
  await b.open("https://myapp.localhost");

  // "email"/"password" hit data-testid first; they also match the field labels.
  await b.fill("email", "you@example.com");
  await b.fill("password", "correct-horse-battery-staple");
  await b.click("Sign in");

  // Fails the flow (non-zero exit) if the dashboard never appears.
  await b.expectText("Dashboard");
});
