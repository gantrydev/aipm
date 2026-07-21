const GUARDS = new Set([
  "requireWorkspaceMember",
  "resolveWorkspaceInstallation",
  "resolveWorkspaceInstallationOrLegacy",
  "requireEnabledRepository",
  "requireEnabledRepositoryUnlessLegacy",
  "verifyInstallationBelongsToWorkspace",
  "handleGithubInstallationLifecycle",
]);

const allowed = (context) => {
  const filename = (context.filename ?? context.getFilename?.() ?? "").replaceAll("\\", "/");
  return (context.options[0]?.allowPaths ?? []).some((path) => filename.endsWith(path));
};

const accessesTenantState = (source) =>
  /(?:\.DB\b|createWorkspaceStore\s*\(|\.idFromName\s*\()/.test(source);

const isEntryPointFile = (context) => {
  const filename = (context.filename ?? "").replaceAll("\\", "/");
  return (
    filename.includes("/apps/worker/src/routes/") ||
    filename.endsWith("/apps/worker/src/index.ts") ||
    filename.endsWith("/apps/worker/src/coordinator.ts")
  );
};

export default {
  meta: {
    type: "problem",
    schema: [
      {
        type: "object",
        properties: { allowPaths: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
    ],
    messages: {
      guard: "Tenant-state entry points must obtain WorkspaceContext through an approved guard.",
    },
  },
  create(context) {
    if (allowed(context) || !isEntryPointFile(context)) return {};
    const guardNames = new Set(GUARDS);
    const sourceCode = context.sourceCode;
    const check = (node) => {
      const source = sourceCode.getText(node);
      if (!accessesTenantState(source)) return;
      const guarded = [...guardNames].some((name) => new RegExp(`\\b${name}\\s*\\(`).test(source));
      if (!guarded) context.report({ node, messageId: "guard" });
    };
    return {
      ImportSpecifier(node) {
        if (GUARDS.has(node.imported.name)) guardNames.add(node.local.name);
      },
      ExportNamedDeclaration(node) {
        if (node.declaration?.type === "FunctionDeclaration") check(node.declaration);
        if (node.declaration?.type === "VariableDeclaration") check(node.declaration);
      },
      ExportDefaultDeclaration(node) {
        check(node.declaration);
      },
    };
  },
};
