/**
 * Jest (ts-jest) para @voyya/api.
 * `@voyya/shared` se resuelve al CÓDIGO FUENTE (no al dist) para poder correr los
 * tests sin pre-compilar el paquete compartido.
 */
/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  // Se ejecuta ANTES de importar los módulos de test (fija env dummy para el
  // ConfigModule, que valida al importarse). Sin depender de un `.env` local.
  setupFiles: ['<rootDir>/test/jest.setup.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testRegex: '.*\\.(spec|e2e-spec)\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  moduleNameMapper: {
    '^@voyya/shared$': '<rootDir>/../../packages/shared/src/index.ts',
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.module.ts', '!src/main.ts'],
  coverageDirectory: '<rootDir>/coverage',
  clearMocks: true,
};
