import { createElement } from "react";
import { defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Renders the page into index.html at build time, so the HTML that ships
 * carries the real copy (crawlers, no-JS readers) instead of an empty div.
 * The client mounts with createRoot, which replaces this markup outright —
 * no hydration, so no mismatch when prefers-reduced-motion differs.
 */
function prerender(): Plugin {
  return {
    name: "bx-prerender",
    apply: "build",
    async transformIndexHtml(html) {
      const [{ renderToStaticMarkup }, { App }] = await Promise.all([
        import("react-dom/server"),
        import("./src/App"),
      ]);
      const markup = renderToStaticMarkup(createElement(App));
      return html.replace('<div id="root"></div>', `<div id="root">${markup}</div>`);
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), prerender()],
});
