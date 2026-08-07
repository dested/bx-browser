import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

/**
 * Fires once, when the element first crosses the viewport threshold.
 *
 * IntersectionObserver is the primary path, backed by a scroll/resize rect
 * check: an occluded or throttled tab can leave IO silent indefinitely, and
 * content that only appears on intersection would then never appear at all.
 */
export function useInViewOnce<T extends Element>(
  threshold = 0.35,
): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node || seen) return;

    let done = false;
    const reveal = () => {
      if (done) return;
      done = true;
      setSeen(true);
    };

    const check = () => {
      const rect = node.getBoundingClientRect();
      const visible =
        Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
      const reference = Math.min(rect.height, window.innerHeight);
      if (reference > 0 && visible / reference >= threshold) reveal();
    };

    const observer =
      typeof IntersectionObserver === "undefined"
        ? undefined
        : new IntersectionObserver(
            (entries) => {
              for (const entry of entries) if (entry.isIntersecting) reveal();
            },
            { threshold },
          );
    observer?.observe(node);

    check();
    window.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check);

    return () => {
      observer?.disconnect();
      window.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
    };
  }, [seen, threshold]);

  return [ref, seen];
}

function legacyCopy(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(area);
  return ok;
}

export function useCopy(text: string): [boolean, () => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const flash = () => {
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1800);
  };

  const copy = () => {
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).then(flash, () => {
        if (legacyCopy(text)) flash();
      });
      return;
    }
    if (legacyCopy(text)) flash();
  };

  return [copied, copy];
}
