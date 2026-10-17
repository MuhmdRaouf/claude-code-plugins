import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: {
    ignorePatterns: ["dist/**", "plugin/dist/**", "coverage/**"],
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
    // The plugin/ tree is what a user installs; it keeps the formatting it shipped with.
    ignorePatterns: ["plugin/**"],
    useTabs: false,
    tabWidth: 2,
    printWidth: 110,
    singleQuote: false,
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
