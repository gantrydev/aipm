import type { D1Migration } from "cloudflare:test";
import type { Env } from "../src/env.js";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: Array<D1Migration>;
  }
}
