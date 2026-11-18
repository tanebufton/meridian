'use strict';
const js = require('@eslint/js');
const globals = require('globals');
const reactHooks = require('eslint-plugin-react-hooks');

// Backend, scripts and tests (CommonJS / Node). The React apps are not linted here.
module.exports = [
  // React apps: only the Rules of Hooks. Conditional hooks are invisible to the build and to unit tests and
  // crash the page at runtime (this caught a real /tv navigation crash). Style/unused-var rules are not applied here.
  {
    files: ['apps/**/*.{js,jsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } }, globals: { ...globals.browser } },
    rules: { 'react-hooks/rules-of-hooks': 'error' },
  },
  { ignores: ['node_modules/**', 'apps/*/dist/**', 'data/**', 'docs/**', 'examples/**'] },
  { ...js.configs.recommended, ignores: ['apps/**'] },
  {
    files: ['**/*.js'],
    ignores: ['apps/**'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-useless-escape': 'warn',
    },
  },
  { files: ['tests/ui/**/*.mjs', 'tests/ui/**/*.js'], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
];
