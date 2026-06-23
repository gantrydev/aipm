import noTryCatch from "./rules/no-try-catch.mjs";

const plugin = {
  meta: {
    name: "local",
    version: "0.1.0",
  },
  rules: {
    "no-try-catch": noTryCatch,
  },
};

export default plugin;
