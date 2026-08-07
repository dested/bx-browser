/** An identifier inside prose: monospace, and never broken across lines. */
export function C({ children }: { children: string }) {
  return (
    <span className="font-mono text-[0.92em] whitespace-nowrap text-chalk">{children}</span>
  );
}
