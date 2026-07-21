import { RuleTester } from "eslint";
import { describe, it } from "node:test";
import tseslint from "typescript-eslint";
import noDirectD1Access from "./no-direct-d1-access.mjs";
import noUnscopedTenantPrimitive from "./no-unscoped-tenant-primitive.mjs";
import noAdHocTenantKey from "./no-ad-hoc-tenant-key.mjs";
import noUnverifiedWorkspaceId from "./no-unverified-workspace-id.mjs";
import requireWorkspaceGuard from "./require-workspace-guard.mjs";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    ecmaVersion: 2024,
    sourceType: "module",
  },
});

tester.run("no-direct-d1-access", noDirectD1Access, {
  valid: [
    {
      code: `createWorkspaceStore(database, workspaceId);`,
      filename: "/repo/apps/worker/src/service.ts",
    },
    {
      code: `const { DB: database } = env; database.prepare("SELECT 1");`,
      filename: "/repo/packages/db/src/index.ts",
      options: [{ allowPaths: ["packages/db/src/index.ts"] }],
    },
  ],
  invalid: [
    {
      code: `import { D1Store as Store } from "@aipm/db"; new Store(env.DB);`,
      filename: "/repo/apps/worker/src/bad.ts",
      errors: [{ messageId: "direct" }, { messageId: "direct" }],
    },
    {
      code: `const { DB: database } = env; database.prepare("SELECT 1");`,
      filename: "/repo/apps/worker/src/bad.ts",
      errors: [{ messageId: "direct" }, { messageId: "direct" }],
    },
  ],
});

tester.run("no-unscoped-tenant-primitive", noUnscopedTenantPrimitive, {
  valid: [
    {
      code: `tenantKv(workspaceId).put(key, value);`,
      filename: "/repo/apps/worker/src/service.ts",
    },
  ],
  invalid: [
    {
      code: `env.CLUSTER_COORDINATOR.idFromName(clusterId);`,
      filename: "/repo/apps/worker/src/bad.ts",
      errors: [{ messageId: "unscoped" }],
    },
    {
      code: `const { DELIVERY_DEDUPE: cache } = env; cache.put(key, "1");`,
      filename: "/repo/apps/worker/src/bad.ts",
      errors: [{ messageId: "unscoped" }],
    },
  ],
});

tester.run("no-ad-hoc-tenant-key", noAdHocTenantKey, {
  valid: [
    {
      code: `deliveryKey(workspaceId, deliveryId);`,
      filename: "/repo/apps/worker/src/service.ts",
    },
    {
      code: "const key = `delivery:${workspaceId}:${deliveryId}`;",
      filename: "/repo/apps/worker/src/tenancy/keys.ts",
      options: [{ allowPaths: ["apps/worker/src/tenancy/keys.ts"] }],
    },
  ],
  invalid: [
    {
      code: "const key = `delivery:${deliveryId}`;",
      filename: "/repo/apps/worker/src/bad.ts",
      errors: [{ messageId: "key" }],
    },
    {
      code: `const key = "repo-inst:" + fullName;`,
      filename: "/repo/apps/worker/src/bad.ts",
      errors: [{ messageId: "key" }, { messageId: "key" }],
    },
  ],
});

tester.run("no-unverified-workspace-id", noUnverifiedWorkspaceId, {
  valid: [
    {
      code: `workspaceIdFromTrustedSource(value);`,
      filename: "/repo/apps/worker/src/tenancy/guards.ts",
      options: [{ allowPaths: ["apps/worker/src/tenancy/guards.ts"] }],
    },
  ],
  invalid: [
    {
      code: `const workspaceId = value as WorkspaceId;`,
      filename: "/repo/apps/worker/src/bad.ts",
      errors: [{ messageId: "workspace" }],
    },
    {
      code: `import { workspaceIdFromTrustedSource as brand } from "@aipm/db"; brand(value);`,
      filename: "/repo/apps/worker/src/bad.ts",
      errors: [{ messageId: "workspace" }],
    },
  ],
});

tester.run("require-workspace-guard", requireWorkspaceGuard, {
  valid: [
    {
      code: `import { requireWorkspaceMember as guard } from "./guards.js";
        export async function handler(env, id, user) {
          const membership = await guard(env.DB, id, user);
          return membership;
        }`,
      filename: "/repo/apps/worker/src/routes/control.ts",
    },
  ],
  invalid: [
    {
      code: `export async function handler(env, workspaceId) {
        return createWorkspaceStore(env.DB, workspaceId);
      }`,
      filename: "/repo/apps/worker/src/routes/control.ts",
      errors: [{ messageId: "guard" }],
    },
  ],
});
