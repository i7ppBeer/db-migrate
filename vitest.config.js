export default {
  testEnvironment: 'node',
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/**/*.test.js',
  ],
  coverageDirectory: 'coverage',
  testMatch: [
    '**/test/**/*.test.js',
    '**/*.test.js',
  ],
};
