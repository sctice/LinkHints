const baseRules = require("eslint-config-lydell");

module.exports = {
  parser: "babel-eslint",
  plugins: [
    "flowtype",
    "flowtype-errors",
    "import",
    "prettier",
    "sort-imports-es6-autofix",
  ],
  env: {
    es6: true,
    node: true,
  },
  rules: Object.assign({}, baseRules({ flow: true, import: true }), {
    "flowtype-errors/show-errors": "error",
    "flowtype/array-style-complex-type": "error",
    "flowtype/array-style-simple-type": "error",
    "func-style": "off",
    "prettier/prettier": "error",
    "sort-imports-es6-autofix/sort-imports-es6": "error",
  }),
  overrides: [
    {
      files: [".*.js", "*.config.js", "web-ext-config.js"],
      rules: {
        "flowtype/require-parameter-type": "off",
        "flowtype/require-return-type": "off",
        "flowtype/require-valid-file-annotation": "off",
      },
    },
    {
      files: ["src/*/**/*.js"],
      env: {
        es6: true,
        node: false,
      },
      globals: {
        BROWSER: false,
        HTMLAnchorElement: false,
        HTMLFrameElement: false,
        HTMLIFrameElement: false,
        IntersectionObserver: false,
        MutationObserver: false,
        browser: false,
        console: false,
        document: false,
        window: false,
      },
    },
  ],
};
