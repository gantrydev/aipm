import eslint from "@eslint/js";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";
import local from "./eslint-rules/index.mjs";

export default defineConfig(
  {
    ignores: [
      "**/dist/**",
      "**/.turbo/**",
      "**/node_modules/**",
      "**/*.test.ts",
      "**/vitest.config.ts",
      "apps/worker/test/**",
      "site/**",
      "**/generated/**",
      "**/worker-configuration.d.ts",
      "eslint.config.mjs",
      "eslint-rules/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/array-type": ["error", { default: "generic" }],
    },
  },
  eslintPluginPrettierRecommended,
  {
    plugins: {
      local,
    },
    rules: {
      "local/no-try-catch": "error",
      "local/no-raw-loops": "error",
    },
  },
);
