import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const shared = fileURLToPath(new URL("../../packages/ui/src", import.meta.url));
const repo = fileURLToPath(new URL("../..", import.meta.url));
const preact = fileURLToPath(new URL("node_modules/preact", import.meta.url));

// The dashboard is one ES module, plugin/public/app.js, and one stylesheet, plugin/public/app.css, next to the
// index.html the server ships as they are: no html entry, no hashed names, no public dir to copy. The CSS entry
// is src/ui/app.css, imported by main.tsx; the @tailwindcss/vite plugin compiles it and the fonts it references
// land in plugin/public/fonts/.
export default defineConfig({
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  plugins: [tailwindcss()],
  // The dashboard's markdown bundles in from the monorepo's shared package (huddle tests it by the same alias);
  // the alias also carries @muhmdraouf/ui/theme.css, which @tailwindcss/vite resolves through vite's resolver.
  resolve: {
    alias: [
      { find: /^@muhmdraouf\/ui\/(.*)$/, replacement: `${shared}/$1` },
      // packages/ui sits outside this plugin, so its "preact" must resolve here, to this one copy: two copies
      // break every hook a shared component calls (huddle's vite.config does the same).
      { find: /^preact$/, replacement: `${preact}/dist/preact.mjs` },
      { find: /^preact\/jsx-dev-runtime$/, replacement: `${preact}/jsx-runtime/dist/jsxRuntime.mjs` },
      { find: /^preact\/(.*)$/, replacement: `${preact}/$1` },
    ],
  },
  // theme.css pulls its IBM Plex faces from packages/ui/node_modules, outside this package's root.
  server: { fs: { allow: [repo] } },
  publicDir: false,
  build: {
    outDir: "plugin/public",
    emptyOutDir: false,
    target: "es2022",
    minify: true,
    sourcemap: false,
    modulePreload: false,
    reportCompressedSize: false,
    rolldownOptions: {
      input: "src/ui/main.tsx",
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
