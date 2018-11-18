const baseRules = require("eslint-config-lydell");

module.exports = {
  parser: "babel-eslint",
  plugins: [
    "flowtype",
    "flowtype-errors",
    "import",
    "prettier",
    "simple-import-sort",
  ],
  env: {
    es6: true,
    node: true,
  },
  rules: Object.assign({}, baseRules({ flow: true, import: true }), {
    "flowtype-errors/show-errors": "error",
    "import/no-restricted-paths": [
      "error",
      {
        basePath: "src",
        // Disallow these dirs from importing from each other.
        zones: makeRestrictedPathsZones([
          "background",
          "popup",
          "renderer",
          "worker",
        ]),
      },
    ],
    "no-console": "error",
    "no-script-url": "off",
    "prettier/prettier": "error",
    "require-await": "error",
  }),
  overrides: [
    {
      files: [".*.js", "*.config.js", "web-ext-*.js"],
      rules: {
        "flowtype/require-parameter-type": "off",
        "flowtype/require-return-type": "off",
        "flowtype/require-valid-file-annotation": "off",
        "import/order": ["error", { "newlines-between": "always" }],
      },
    },
    {
      files: ["src/*/**/*.js", "html/**/*.js"],
      env: {
        es6: true,
        node: false,
      },
      globals: Object.assign({}, baseRules.browserEnv(), {
        BROWSER: true,
        BUILD_TIME: true,
        PROD: false,
        browser: false,
      }),
      rules: {
        "simple-import-sort/sort": "error",
      },
    },
  ],
};

function makeRestrictedPathsZones(dirs) {
  return [].concat(
    ...dirs.map(dir => {
      const otherDirs = dirs.filter(dir2 => dir2 !== dir);
      return otherDirs.map(dir2 => ({ target: dir, from: dir2 }));
    })
  );
}
