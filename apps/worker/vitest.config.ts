import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        // Tests run fully local; the LLM is mocked (EchoLlmAdapter), so we don't
        // need a remote proxy session for the AI binding.
        remoteBindings: false,
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // A secret must be present so the github route exercises real signature
          // verification; without it the route 500s on missing config, not 401.
          bindings: { TEST_MIGRATIONS: migrations, GITHUB_WEBHOOK_SECRET: "test-webhook-secret" },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
