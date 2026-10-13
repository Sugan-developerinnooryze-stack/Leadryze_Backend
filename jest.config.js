/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    // See tests/__mocks__/puppeteer.ts — the real package's CJS entrypoint
    // re-exports via ESM syntax, which crashes ts-jest's transform.
    '^puppeteer$': '<rootDir>/tests/__mocks__/puppeteer.ts',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { rootDir: '.' } }],
  },
  setupFilesAfterFramework: [],
  testTimeout: 30000,
};
