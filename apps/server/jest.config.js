/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  // 测试直接使用共享包源码，无需先构建
  moduleNameMapper: { '^@creature/shared$': '<rootDir>/../../packages/shared/src/index.ts' },
  testTimeout: 30000,
};
