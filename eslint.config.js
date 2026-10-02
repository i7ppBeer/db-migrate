import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-console': 'off',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    // Migration files and templates: up(db, client) / down(db, client) is the
    // signature the runner calls, so an unused parameter there documents the
    // API rather than being dead code.
    files: ['test-fixtures/**/*.js', 'templates/**/*.js'],
    rules: {
      'no-unused-vars': ['warn', { args: 'none' }],
    },
  },
];
