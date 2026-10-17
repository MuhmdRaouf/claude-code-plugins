import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: {
    ignorePatterns: ["coverage/**"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    rules: {
      "typescript/no-explicit-any": "error",
      "import/no-default-export": "error",
      "typescript/consistent-type-imports": "error",
      "typescript/no-non-null-assertion": "error",
      complexity: ["error", { max: 12 }],
    },
    overrides: [
      {
        files: ["vite.config.ts"],
        rules: { "import/no-default-export": "off" },
      },
    ],
  },
  fmt: {
    useTabs: false,
    tabWidth: 2,
    printWidth: 110,
    singleQuote: false,
  },
});
