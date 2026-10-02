import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'test/**/*.test.js',
    ],
    // integration.test.js hits a real MariaDB (see vitest.integration.config.js
    // + `npm run test:integration`) — keep the default `npm test` fast/offline.
    exclude: [...configDefaults.exclude, 'test/integration.test.js', 'test/mysql-compat.test.js'],
    coverage: {
      provider: 'v8',
      include: [
        'src/**/*.js',
      ],
      exclude: [
        'src/**/*.test.js',
      ],
      reportsDirectory: 'coverage',
      // Floors just under what the unit tests reach today (2026-10-02:
      // statements 48.9, branches 49.0, functions 62.8, lines 48.1), so
      // coverage can't quietly slide. src/cli.js counts as 0 here — it's
      // exercised by the Docker test-all E2E suite and test:integration,
      // not by unit tests. Raise these as coverage improves.
      thresholds: {
        statements: 48,
        branches: 48,
        functions: 62,
        lines: 47,
      },
    },
  },
});
