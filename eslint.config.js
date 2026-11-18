'use strict';
const js = require('@eslint/js');
const globals = require('globals');

// Backend, scripts and tests (CommonJS / Node). The React apps are not linted here.
module.exports = [
  { ignores: ['node_modules/**', 'apps/**', 'data/**', 'docs/**', 'examples/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
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
