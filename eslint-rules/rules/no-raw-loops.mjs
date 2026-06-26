const MESSAGES = {
  ForStatement:
    "No raw for loops. Use map / flatMap / reduce, or asyncMap from @aipm/core.",
  ForOfStatement:
    "No for-of loops. Use map / flatMap / reduce, or asyncMap from @aipm/core.",
  ForInStatement:
    "No for-in loops. Use Object.keys / Object.entries with map / reduce.",
  WhileStatement: "No while loops. Use a recursive helper or reduce.",
  DoWhileStatement: "No do-while loops. Use a recursive helper or reduce.",
};

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid all imperative loop forms (for, for-of, for-in, while, do-while).",
      recommended: true,
    },
    schema: [],
    messages: {
      noForStatement: MESSAGES.ForStatement,
      noForOfStatement: MESSAGES.ForOfStatement,
      noForInStatement: MESSAGES.ForInStatement,
      noWhileStatement: MESSAGES.WhileStatement,
      noDoWhileStatement: MESSAGES.DoWhileStatement,
    },
  },

  create(ctx) {
    return {
      ForStatement(node) {
        ctx.report({ node: node, messageId: "noForStatement" });
      },
      ForOfStatement(node) {
        ctx.report({ node: node, messageId: "noForOfStatement" });
      },
      ForInStatement(node) {
        ctx.report({ node: node, messageId: "noForInStatement" });
      },
      WhileStatement(node) {
        ctx.report({ node: node, messageId: "noWhileStatement" });
      },
      DoWhileStatement(node) {
        ctx.report({ node: node, messageId: "noDoWhileStatement" });
      },
    };
  },
};
