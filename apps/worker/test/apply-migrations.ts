import { applyD1Migrations, env } from "cloudflare:test";

// Runs outside per-test storage isolation; only applies un-applied migrations.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
