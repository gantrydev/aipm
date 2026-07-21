const allowed = (context) => {
  const filename = (context.filename ?? context.getFilename?.() ?? "").replaceAll("\\", "/");
  return (context.options[0]?.allowPaths ?? []).some((path) => filename.endsWith(path));
};

const workspaceTypeName = (typeAnnotation) =>
  typeAnnotation?.type === "TSTypeReference" &&
  typeAnnotation.typeName.type === "Identifier" &&
  typeAnnotation.typeName.name === "WorkspaceId";

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
      workspace:
        "WorkspaceId may only be created by an allowlisted verified resolver or bootstrap module.",
    },
  },
  create(context) {
    if (allowed(context)) return {};
    const constructors = new Set(["workspaceIdFromTrustedSource"]);
    return {
      ImportSpecifier(node) {
        if (node.imported.name === "workspaceIdFromTrustedSource") {
          constructors.add(node.local.name);
        }
      },
      TSAsExpression(node) {
        if (workspaceTypeName(node.typeAnnotation)) {
          context.report({ node, messageId: "workspace" });
        }
      },
      TSTypeAssertion(node) {
        if (workspaceTypeName(node.typeAnnotation)) {
          context.report({ node, messageId: "workspace" });
        }
      },
      CallExpression(node) {
        if (node.callee.type === "Identifier" && constructors.has(node.callee.name)) {
          context.report({ node, messageId: "workspace" });
        }
      },
    };
  },
};
