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
      "local/no-direct-d1-access": [
        "error",
        {
          allowPaths: [
            "packages/db/src/d1-store.ts",
            "packages/db/src/index.ts",
            "packages/db/src/control-plane.ts",
            "packages/db/src/public-safety.ts",
            "apps/worker/src/tenancy/guards.ts",
            "apps/worker/src/tenancy/audit.ts",
            "apps/worker/src/tenancy/lifecycle.ts",
            "apps/worker/src/tenancy/config.ts",
            "apps/worker/src/tenancy/sweeps.ts",
            "apps/worker/src/tenancy/offboarding.ts",
            "apps/worker/src/auth/session.ts",
            "apps/worker/src/routes/api.ts",
            "apps/worker/test/apply-migrations.ts",
          ],
        },
      ],
      "local/no-unscoped-tenant-primitive": [
        "error",
        {
          allowPaths: [
            "apps/worker/src/tenancy/keys.ts",
            "apps/worker/src/tenancy/kv.ts",
            "apps/worker/src/tenancy/durable.ts",
            "apps/worker/src/tenancy/index.ts",
            "apps/worker/src/tenancy/budgets.ts",
            "apps/worker/src/tenancy/offboarding.ts",
            "apps/worker/src/auth/session.ts",
            "apps/worker/src/routes/slack.ts",
          ],
        },
      ],
      "local/no-ad-hoc-tenant-key": [
        "error",
        {
          allowPaths: [
            "apps/worker/src/tenancy/keys.ts",
            "apps/worker/src/tenancy/kv.ts",
            "apps/worker/src/tenancy/budgets.ts",
            "apps/worker/src/coordinator.ts",
            "apps/worker/src/routes/github.ts",
            "apps/worker/src/routes/slack.ts",
            "packages/adapter-llm/src/index.ts",
          ],
        },
      ],
      "local/no-unverified-workspace-id": [
        "error",
        {
          allowPaths: [
            "packages/db/src/workspace.ts",
            "packages/db/src/control-plane.ts",
            "apps/worker/src/messages.ts",
            "apps/worker/src/tenancy/guards.ts",
            "apps/worker/src/tenancy/lifecycle.ts",
          ],
        },
      ],
      "local/require-workspace-guard": [
        "error",
        {
          allowPaths: [
            "apps/worker/src/context.ts",
            "apps/worker/src/coordinator.ts",
            "apps/worker/src/merge-registry.ts",
          ],
        },
      ],
    },
  },
);
