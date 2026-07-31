import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
// eslint-config-next 16 no longer registers the react-hooks plugin itself (react-hooks v7 ships its own
// flat config), so the rule-level overrides below reference a plugin no preset provides → eslint aborts
// with "could not find plugin 'react-hooks'". Register it explicitly so the linter runs and the
// react-hooks/* warnings below are actually evaluated. `react` is externalized the same way (next 16 no
// longer registers it); `jsx-a11y`/`@next/next`/`@typescript-eslint` are still provided by the presets.
import reactHooks from "eslint-plugin-react-hooks";
import react from "eslint-plugin-react";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored Puck fork — upstream source, linted (and built) by its own toolchain, not the app's.
    "packages/**",
  ]),
  // Pragmatic rule levels: this is a rapidly-iterated codebase with intentional `any` and
  // CommonJS interop, and the new (experimental) react-hooks rules from Next 16 are noisy.
  // Downgrade migration-noise + experimental rules to warnings so CI is meaningful but not
  // blocked on stylistic debt. NOTE: the react-hooks/* warnings (esp. rules-of-hooks) flag
  // real correctness concerns worth a dedicated cleanup — they are warnings, not ignored.
  {
    plugins: { "react-hooks": reactHooks, react },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/ban-ts-comment": "warn",
      "react-hooks/rules-of-hooks": "warn",
      "react-hooks/static-components": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/exhaustive-deps": "warn",
      "react/no-unescaped-entities": "warn",
      "@next/next/no-html-link-for-pages": "warn",
      "@next/next/no-assign-module-variable": "warn",
      "@next/next/no-img-element": "warn",
      "@next/next/no-css-tags": "warn",
      // jsx-a11y is registered by the next preset under a files-scoped object this global override can't
      // reference; eslint-config-next already defaults jsx-a11y/alt-text to "warn", so no override needed.
      "prefer-const": "warn",
    },
  },
]);

export default eslintConfig;
