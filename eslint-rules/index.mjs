import noTryCatch from "./rules/no-try-catch.mjs";
import noRawLoops from "./rules/no-raw-loops.mjs";
import noDirectD1Access from "./rules/no-direct-d1-access.mjs";
import noUnscopedTenantPrimitive from "./rules/no-unscoped-tenant-primitive.mjs";
import noAdHocTenantKey from "./rules/no-ad-hoc-tenant-key.mjs";
import noUnverifiedWorkspaceId from "./rules/no-unverified-workspace-id.mjs";
import requireWorkspaceGuard from "./rules/require-workspace-guard.mjs";

const plugin = {
  meta: {
    name: "local",
    version: "0.1.0",
  },
  rules: {
    "no-try-catch": noTryCatch,
    "no-raw-loops": noRawLoops,
    "no-direct-d1-access": noDirectD1Access,
    "no-unscoped-tenant-primitive": noUnscopedTenantPrimitive,
    "no-ad-hoc-tenant-key": noAdHocTenantKey,
    "no-unverified-workspace-id": noUnverifiedWorkspaceId,
    "require-workspace-guard": requireWorkspaceGuard,
  },
};

export default plugin;
