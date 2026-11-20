import babel from "@rolldown/plugin-babel";
import { defineConfig } from "vite-plus";

// vp migrate: merged .oxlintrc.json (361ff683c7d1dc2011f28dd434f7f93d).
import oxlintConfig from "./.oxlintrc.js";

/**
 * Each package runs `vp test` in its own directory. `root` follows that
 * directory so the include pattern stays the package's tests.
 *
 * Oxc does not lower standard decorators, so Babel does for files that use one.
 */
export default defineConfig({
  plugins: [
    babel({
      presets: [
        {
          preset: () => ({
            plugins: [["@babel/plugin-proposal-decorators", { version: "2023-11" }]],
          }),
          rolldown: {
            filter: { code: /(?:^|\n)\s*@[A-Za-z_$]/ },
          },
        },
      ],
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    root: process.cwd(),
  },
  fmt: {
    ignorePatterns: [
      "**/dist/**",
      "**/puppi-env.d.ts",
      "pnpm-lock.yaml",
      "**/*.md",
      "connectors/**/openapi.json",
    ],
    sortImports: true,
  },
  lint: {
    extends: [oxlintConfig],
    env: oxlintConfig.env,
    ignorePatterns: oxlintConfig.ignorePatterns,
    options: {
      // `vp lint --type-aware` opts in. tsrs typecheck does not see the same
      // libs and `@types/node` as the package tsconfigs, so `tsc` still typechecks.
      typeAware: false,
      typeCheck: false,
    },
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
    },
  },
});
