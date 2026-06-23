export default {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      noTryCatch:
        "No try/catch. Use Result.from() (async) or Result.fromSync() (sync) from @aipm/core.",
    },
  },

  create(ctx) {
    return {
      TryStatement(node) {
        ctx.report({ node: node, messageId: "noTryCatch" });
      },
    };
  },
};
