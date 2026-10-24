const js = require("@eslint/js");
const globals = require("globals");
const sonarjs = require("eslint-plugin-sonarjs");

module.exports = [
  { ignores: ["node_modules/", "public/", "coverage/"] },
  js.configs.recommended,
  sonarjs.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: { ecmaVersion: "latest", sourceType: "commonjs", globals: globals.node },
    rules: {
      // Positional params we must accept but don't use are prefixed "_"
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      // `catch (_) { return fallback; // why }` is our deliberate fallback pattern
      "sonarjs/no-ignored-exceptions": "off",
    },
  },
  {
    files: ["tests/**/*.js"],
    languageOptions: { globals: globals.jest },
    rules: {
      // Test data: fake hosts/IPs over http, scripts for child processes built as templates
      "sonarjs/no-hardcoded-ip": "off",
      "sonarjs/no-clear-text-protocols": "off",
      "sonarjs/no-nested-template-literals": "off",
      "sonarjs/no-identical-functions": "off",
      // Regexes here only check our own output (e.g. the Prometheus format)
      "sonarjs/super-linear-regex": "off",
      "sonarjs/regex-complexity": "off",
    },
  },
];
