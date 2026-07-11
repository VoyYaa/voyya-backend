/**
 * ESLint raíz — backend VoyYa (standalone).
 * Regla dura del proyecto: prohibido `any` (coding-standards.md).
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'eslint-config-prettier',
  ],
  env: {
    node: true,
    es2022: true,
    jest: true,
  },
  ignorePatterns: [
    'node_modules',
    'dist',
    'coverage',
    '.turbo',
    '**/*.js',
    '**/*.cjs',
    '**/generated/**',
    '**/prisma/generated/**',
  ],
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    'no-unused-vars': 'off',
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
    ],
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/no-non-null-assertion': 'warn',
  },
};
