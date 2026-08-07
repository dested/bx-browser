import type { ReactNode } from "react";
import { C } from "./Code";

const ITEMS: { title: string; body: ReactNode }[] = [
  {
    title: "Your own logged-in daily browser",
    body: (
      <>
        bx drives its own profiles under <C>~/.bx/profiles</C>. Chrome 136+ blocks
        CDP on the default user-data-dir and app-bound encryption blocks importing
        cookies, so the browser you already have open, with all its sessions,
        stays out of reach. The extension lives inside it. (A bridge extension
        into your daily Chrome is the v2 roadmap.)
      </>
    ),
  },
  {
    title: "Hierarchical accessibility-tree reads",
    body: (
      <>
        <C>els</C> returns a flat, numbered list tuned for acting on things. When
        the question is about structure — nesting, landmarks, what contains what —{" "}
        <C>read_page</C>'s tree is genuinely the better read.
      </>
    ),
  },
  {
    title: "Arbitrary third-party sites",
    body: (
      <>
        bx is built for driving apps you're actually working on — a dev server,
        a real project, a flow file worth keeping. For one-off poking at a site
        you have never seen, the screenshot loop needs no setup and no profile.
      </>
    ),
  },
];

export function Honesty() {
  return (
    <ul className="grid gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-3">
      {ITEMS.map((item) => (
        <li key={item.title} className="bg-panel p-6 md:p-7">
          <h3 className="text-base font-semibold text-chalk">{item.title}</h3>
          <p className="mt-3 text-sm leading-relaxed text-fog">{item.body}</p>
        </li>
      ))}
    </ul>
  );
}
