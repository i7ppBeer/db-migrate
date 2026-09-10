import { defineConfig } from 'vitest/config';

// Separate config for the real-MariaDB e2e suite (test/integration.test.js).
// vitest.config.js excludes this file so `npm test` stays fast/offline;
// `npm run test:integration` points here instead, which does NOT exclude it.
export default defineConfig({
  test: {
    include: ['test/integration.test.js'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
