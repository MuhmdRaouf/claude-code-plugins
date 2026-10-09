import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const shared = fileURLToPath(new URL("../../../packages/ui/src", import.meta.url));
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const preact = fileURLToPath(new URL("../node_modules/preact", import.meta.url));

// The dashboard is one ES module, plugin/server/public/app.js, and one stylesheet, app.css, next to
// the index.html the server ships as they are: no html entry, no hashed names, no public dir to copy.
// The CSS entry is src/app.css, imported by main.tsx; @tailwindcss/vite compiles it and the fonts it
// references land in plugin/server/public/fonts/ (radar's vite.config).
export default defineConfig({
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  plugins: [tailwindcss()],
  resolve: {
    alias: [
      { find: /^@muhmdraouf\/ui\/(.*)$/, replacement: `${shared}/$1` },
      // packages/ui sits outside this plugin, so its "preact" resolves here, to this one copy.
      // A test run's NODE_ENV makes the JSX transform ask for the dev runtime; this preact copy
      // spells it through the jsx-runtime directory (its exports map), so alias it there directly.
      { find: /^preact$/, replacement: `${preact}/dist/preact.mjs` },
      { find: /^preact\/jsx-dev-runtime$/, replacement: `${preact}/jsx-runtime/dist/jsxRuntime.mjs` },
      { find: /^preact\/(.*)$/, replacement: `${preact}/$1` },
    ],
  },
  // theme.css pulls its IBM Plex faces from packages/ui/node_modules, outside this package's root.
  server: { fs: { allow: [repo] } },
  publicDir: false,
  build: {
    outDir: "../plugin/server/public",
    emptyOutDir: false,
    target: "es2022",
    minify: true,
    sourcemap: false,
    modulePreload: false,
    reportCompressedSize: false,
    rolldownOptions: {
      input: "src/main.tsx",
      output: {
        format: "es",
        entryFileNames: "app.js",
        // app.css keeps its exact name (index.html links it); the bundled fonts collect under fonts/.
        assetFileNames: (asset) =>
          asset.names.some((name) => name.endsWith(".css")) ? "app.css" : "fonts/[name][extname]",
        codeSplitting: false,
      },
    },
  },
});
