const allowed = (context) => {
  const filename = (context.filename ?? context.getFilename?.() ?? "").replaceAll("\\", "/");
  return (context.options[0]?.allowPaths ?? []).some((path) => filename.endsWith(path));
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
      direct: "Use createWorkspaceStore() or an approved workspace persistence boundary.",
    },
  },
  create(context) {
    if (allowed(context)) return {};
    const storeNames = new Set(["D1Store"]);
    const dbNames = new Set(["db", "DB"]);
    return {
      ImportSpecifier(node) {
        if (node.imported.name === "D1Store") storeNames.add(node.local.name);
      },
      VariableDeclarator(node) {
        if (node.id.type !== "ObjectPattern") return;
        const sourceIsEnv = node.init?.type === "Identifier" && node.init.name === "env";
        if (!sourceIsEnv) return;
        node.id.properties.forEach((property) => {
          if (property.type !== "Property") return;
          if (property.key.type === "Identifier" && property.key.name === "DB") {
            if (property.value.type === "Identifier") dbNames.add(property.value.name);
            context.report({ node: property, messageId: "direct" });
          }
        });
      },
      MemberExpression(node) {
        const workspaceFactoryArgument =
          node.parent.type === "CallExpression" &&
          node.parent.callee.type === "Identifier" &&
          node.parent.callee.name === "createWorkspaceStore";
        const envDb =
          node.object.type === "Identifier" &&
          node.object.name === "env" &&
          node.property.type === "Identifier" &&
          node.property.name === "DB" &&
          !workspaceFactoryArgument;
        const directPrepare =
          node.property.type === "Identifier" &&
          node.property.name === "prepare" &&
          node.object.type === "Identifier" &&
          dbNames.has(node.object.name);
        if (envDb || directPrepare) context.report({ node, messageId: "direct" });
      },
      NewExpression(node) {
        if (node.callee.type === "Identifier" && storeNames.has(node.callee.name)) {
          context.report({ node, messageId: "direct" });
        }
      },
    };
  },
};
