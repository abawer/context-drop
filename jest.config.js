/** @type {import('jest').Config} */
const config = {
  testEnvironment: 'jsdom',
  testMatch: ['**/tests/unit/**/*.test.js'],
  roots: ['<rootDir>'],
  moduleFileExtensions: ['js', 'mjs', 'json', 'node'],
  transform: {
    '^.+\\.js$': 'babel-jest',
  },
  setupFilesAfterEnv: ['<rootDir>/tests/setup/chrome-mocks.js'],
  collectCoverageFrom: ['src/**/*.js'],
};

export default config;
