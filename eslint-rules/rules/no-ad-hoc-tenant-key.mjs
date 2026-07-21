const PREFIX =
  /^(gh|delivery|installation-token|repo-inst|repository-installation|llm:budget|llm-budget|llm-cache|coordinator|merge-registry|work):/;

const allowed = (context) => {
  const filename = (context.filename ?? context.getFilename?.() ?? "").replaceAll("\\", "/");
  return (context.options[0]?.allowPaths ?? []).some((path) => filename.endsWith(path));
};

const text = (node) => {
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral") return node.quasis[0]?.value.raw ?? "";
  return undefined;
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
      key: "Construct recognized tenant keys through apps/worker/src/tenancy/keys.ts.",
    },
  },
  create(context) {
    if (allowed(context)) return {};
    return {
      Literal(node) {
        if (typeof node.value === "string" && PREFIX.test(node.value)) {
          context.report({ node, messageId: "key" });
        }
      },
      TemplateLiteral(node) {
        if (PREFIX.test(text(node) ?? "")) context.report({ node, messageId: "key" });
      },
      BinaryExpression(node) {
        if (node.operator === "+" && PREFIX.test(text(node.left) ?? "")) {
          context.report({ node, messageId: "key" });
        }
      },
    };
  },
};
