import noTryCatch from "./rules/no-try-catch.mjs";
import noRawLoops from "./rules/no-raw-loops.mjs";

const plugin = {
  meta: {
    name: "local",
    version: "0.1.0",
  },
  rules: {
    "no-try-catch": noTryCatch,
    "no-raw-loops": noRawLoops,
  },
};

export default plugin;
