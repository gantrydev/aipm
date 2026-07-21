const TENANT_BINDINGS = new Set([
  "DELIVERY_DEDUPE",
  "INSTALL_TOKENS",
  "CLUSTER_COORDINATOR",
  "MERGE_REGISTRY",
]);

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
      unscoped: "Use a workspace-scoped primitive wrapper from tenancy helpers.",
    },
  },
  create(context) {
    if (allowed(context)) return {};
    const tenantAliases = new Set();
    return {
      VariableDeclarator(node) {
        if (node.id.type !== "ObjectPattern") return;
        node.id.properties.forEach((property) => {
          if (
            property.type === "Property" &&
            property.key.type === "Identifier" &&
            TENANT_BINDINGS.has(property.key.name) &&
            property.value.type === "Identifier"
          ) {
            tenantAliases.add(property.value.name);
          }
        });
      },
      CallExpression(node) {
        if (node.callee.type !== "MemberExpression") return;
        const method =
          node.callee.property.type === "Identifier" ? node.callee.property.name : undefined;
        if (method === "idFromName") {
          context.report({ node, messageId: "unscoped" });
          return;
        }
        if (method !== "get" && method !== "put" && method !== "delete") return;
        const object = node.callee.object;
        const directBinding =
          object.type === "MemberExpression" &&
          object.property.type === "Identifier" &&
          TENANT_BINDINGS.has(object.property.name);
        const alias = object.type === "Identifier" && tenantAliases.has(object.name);
        if (directBinding || alias) context.report({ node, messageId: "unscoped" });
      },
    };
  },
};
