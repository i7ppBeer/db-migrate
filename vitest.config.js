import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'test/**/*.test.js',
    ],
    // integration.test.js hits a real MariaDB (see vitest.integration.config.js
    // + `npm run test:integration`) — keep the default `npm test` fast/offline.
    exclude: [...configDefaults.exclude, 'test/integration.test.js'],
    coverage: {
      provider: 'v8',
      include: [
        'src/**/*.js',
      ],
      exclude: [
        'src/**/*.test.js',
      ],
      reportsDirectory: 'coverage',
    },
  },
});
