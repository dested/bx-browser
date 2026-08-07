import { REPO_URL } from "../lib/constants";

export function Footer() {
  return (
    <footer className="border-t border-line-soft px-5 py-12 sm:px-8">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-6 gap-y-3">
        <a
          href={REPO_URL}
          className="font-mono text-sm text-acid transition-colors hover:text-chalk"
        >
          github.com/dested/claude-browser
        </a>
        <span className="font-mono text-sm text-fog-dim">MIT</span>
        <span className="text-sm text-fog-dim">
          Every transcript, number, and report on this page is real captured
          output — bench and fixture in the repo.
        </span>
      </div>
    </footer>
  );
}
