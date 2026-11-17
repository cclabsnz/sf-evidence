import type { Config } from 'jest';

/**
 * Jest settings shared by every package in the workspace. Each package adds its own `roots`
 * and any package-specific module stubs (the CLI stubs chalk; the engine has nothing to stub).
 */
const base: Config = {
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      '@swc/jest',
      {
        jsc: {
          target: 'es2022',
          parser: { syntax: 'typescript', tsx: false },
          transform: { useDefineForClassFields: true },
        },
        module: { type: 'es6' },
        sourceMaps: true,
      },
    ],
  },
  testMatch: ['**/*.test.ts'],
};

export default base;
