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
import { eslintGlobs } from "./scripts/form-controls-gate.mjs";

// One form kit for the admin (scripts/form-controls-gate.mjs): the files still on its shrink-only
// allowlist are ignored here and held at their count by the formControlsGate test; every other admin
// file may not add a raw control.
const formControls = eslintGlobs();

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
  // The browser's own alert(), confirm() and prompt() are never used: they block the page, cannot be
  // styled or translated, and some embedders (and the admin's own iframes) suppress them. Use the host's
  // useModal() (alert/confirm/prompt) or a toast. A `confirm` destructured from useModal() is a local
  // binding, so no-restricted-globals leaves it alone; only the browser global is refused.
  // tests/no-native-dialogs.test.ts scans the whole repo for the same thing.
  {
    rules: {
      "no-alert": "error",
      "no-restricted-globals": ["error",
        { name: "alert", message: "Use useModal().alert or a toast, not the browser's alert()." },
        { name: "confirm", message: "Use useModal().confirm, not the browser's confirm()." },
        { name: "prompt", message: "Use useModal().prompt, not the browser's prompt()." },
      ],
      "no-restricted-properties": ["error",
        ...["window", "globalThis", "self", "top", "parent"].flatMap((object) => ["alert", "confirm", "prompt"].map((property) => ({
          object, property, message: "The browser's native dialogs are not used: use useModal() or a toast.",
        }))),
      ],
    },
  },
  // The admin's fields and buttons come from @/components/ui (Input, Textarea, Select, Checkbox, Radio,
  // Switch, ColorInput, Slider, the pickers, Button, IconButton, ButtonLink, FileButton, SegmentedControl,
  // Tabs, UnstyledButton). Public/theme-rendered code is out of scope: a theme never ships admin JS.
  {
    files: formControls.files,
    ignores: formControls.ignores,
    rules: {
      "no-restricted-syntax": ["error", {
        selector: "JSXOpeningElement[name.name=/^(input|select|textarea|button)$/]",
        message: "Use the admin form kit (@/components/ui: Input, Textarea, Select, Checkbox, Radio, Switch, Button, IconButton, UnstyledButton…) instead of a raw form element.",
      }],
    },
  },
]);

export default eslintConfig;
