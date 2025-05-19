module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^../services/aiService$': '<rootDir>/src/services/aiService',
    '^../models/types$': '<rootDir>/src/models/types',
    '^../lib/logger$': '<rootDir>/src/lib/logger',
    '^../lib/llmUtils$': '<rootDir>/src/lib/llmUtils',
    '^../lib/repomixUtils$': '<rootDir>/src/lib/repomixUtils',
    '^../lib/dbUtils$': '<rootDir>/src/lib/dbUtils',
    '^../config$': '<rootDir>/src/config',
    '^../services/databaseService$': '<rootDir>/src/services/databaseService',
  },
  setupFiles: ['<rootDir>/tests/setupEnv.ts'],
}
