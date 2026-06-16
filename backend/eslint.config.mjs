import js from '@eslint/js';
import globals from 'globals';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import prettierConfig from 'eslint-config-prettier';

export default [
    // Ignore generated / vendored / data directories
    {
        ignores: [
            'node_modules/**',
            'data/**',
            'uploads/**',
            'plugins/**/node_modules/**',
            'dist/**',
        ],
    },

    // Base JS recommended rules
    js.configs.recommended,

    // TypeScript sources
    {
        files: ['**/*.ts'],
        languageOptions: {
            parser: tsParser,
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...globals.node,
            },
        },
        plugins: {
            '@typescript-eslint': tsPlugin,
        },
        rules: {
            ...tsPlugin.configs.recommended.rules,

            // TypeScript's own compiler handles undefined identifiers; the
            // core no-undef rule is redundant and noisy on TS sources.
            'no-undef': 'off',

            // Pragmatic: freshly-migrated JS->TS codebase with lots of
            // intentional `any` and CommonJS require() calls.
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-var-requires': 'off',
            '@typescript-eslint/no-require-imports': 'off',

            // Prefer the TS-aware unused-vars rule (warn, not error).
            'no-unused-vars': 'off',
            '@typescript-eslint/no-unused-vars': [
                'warn',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
            ],

            // Genuinely useful, low-noise error-level rules.
            'no-debugger': 'error',
            'no-cond-assign': ['error', 'except-parens'],
            'no-dupe-keys': 'error',
            'no-unreachable': 'error',
        },
    },

    // Disable stylistic rules that conflict with Prettier (must be last).
    prettierConfig,
];
