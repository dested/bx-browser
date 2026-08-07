import type { ReactNode } from "react";

export function Section({
  id,
  eyebrow,
  title,
  lede,
  children,
  bordered = true,
  wide = false,
}: {
  id?: string;
  eyebrow?: string;
  title?: string;
  lede?: ReactNode;
  children: ReactNode;
  bordered?: boolean;
  /** Roomier column for side-by-side code, which must not be cramped. */
  wide?: boolean;
}) {
  return (
    <section
      id={id}
      className={`px-5 py-20 sm:px-8 md:py-28 ${bordered ? "border-t border-line-soft" : ""}`}
    >
      <div className={`mx-auto w-full ${wide ? "max-w-7xl" : "max-w-5xl"}`}>
        {(eyebrow || title) && (
          <header className="mb-10 md:mb-14">
            {eyebrow && (
              <p className="mb-3 font-mono text-xs tracking-[0.2em] text-acid uppercase">
                {eyebrow}
              </p>
            )}
            {title && (
              <h2 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl md:text-4xl">
                {title}
              </h2>
            )}
            {lede && (
              <p className="mt-4 max-w-2xl text-base leading-relaxed text-fog text-pretty">
                {lede}
              </p>
            )}
          </header>
        )}
        {children}
      </div>
    </section>
  );
}
