import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "coverage"] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node },
    },
  },

  // --- Architecture & determinism boundary for the engine (ADR-004) ---
  // The engine is pure: it may import only from @/schema, and may never touch
  // browser globals or wall-clock time / unseeded randomness. A violation here
  // is a build failure, not a code-review nit.
  {
    files: ["src/engine/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@/ui",
                "@/ui/*",
                "@/document",
                "@/document/*",
                "@/components",
                "@/components/*",
                "@/workers",
                "@/workers/*",
                "**/ui/*",
                "**/document/*",
                "**/components/*",
                "**/workers/*",
              ],
              message:
                "engine/ may import only from @/schema (DESIGN §1 dependency rule, ADR-004).",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        {
          name: "window",
          message: "engine/ must not touch browser globals (ADR-004).",
        },
        {
          name: "document",
          message: "engine/ must not touch browser globals (ADR-004).",
        },
        {
          name: "performance",
          message:
            "engine/ must use the logical clock, not wall-clock time (ADR-004).",
        },
        {
          name: "Date",
          message:
            "engine/ must use the logical clock, not Date (ADR-004).",
        },
      ],
      "no-restricted-properties": [
        "error",
        {
          object: "Math",
          property: "random",
          message:
            "engine/ must use the injected seeded PRNG, not Math.random (ADR-004).",
        },
        {
          object: "Date",
          property: "now",
          message:
            "engine/ must use the logical clock, not Date.now (ADR-004).",
        },
      ],
    },
  },

  // Test files may use node/test globals freely.
  {
    files: ["**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}"],
    languageOptions: { globals: { ...globals.node } },
  },

  // Ambient declaration files idiomatically use /// <reference> directives.
  {
    files: ["**/*.d.ts"],
    rules: { "@typescript-eslint/triple-slash-reference": "off" },
  },

  prettier,
);
