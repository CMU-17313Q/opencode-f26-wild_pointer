// Type-aware ESLint for the packages we own. Scope is narrowed to
// packages/a2a and packages/plugin-a2a; see ci-evidence/eslint/README.md.
import js from "@eslint/js"
import tseslint from "typescript-eslint"

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/src/generated*/**",
      "**/*.gen.ts",
      "**/*.d.ts",
      "**/test/fixtures/**",
      "**/e2e/fixtures/**",
      "**/demo/**",
    ],
  },
  {
    files: ["packages/a2a/src/**/*.{ts,tsx}", "packages/plugin-a2a/src/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
)
