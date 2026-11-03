import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

const FETCH_MESSAGE =
  'Use the API client in src/api/client.ts. The dashboard may only call endpoints from /openapi.json (Spec 002).';

export default tseslint.config(
  { ignores: ['dist', 'public', 'playwright-report', 'test-results', 'src/api/schema.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-restricted-globals': ['error', { name: 'fetch', message: FETCH_MESSAGE }],
      'no-restricted-properties': [
        'error',
        { object: 'window', property: 'fetch', message: FETCH_MESSAGE },
        { object: 'globalThis', property: 'fetch', message: FETCH_MESSAGE },
        { object: 'self', property: 'fetch', message: FETCH_MESSAGE },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "NewExpression[callee.name='XMLHttpRequest']", message: FETCH_MESSAGE },
      ],
    },
  },
  {
    // The generated-types API client is the single place allowed to call fetch.
    files: ['src/api/client.ts'],
    rules: { 'no-restricted-globals': 'off', 'no-restricted-properties': 'off' },
  },
  {
    files: ['mock/**', 'tests/**', 'e2e/**', '*.config.{ts,js}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    // Test helpers such as useMockDb() are not React hooks; they only share the naming convention.
    files: ['tests/**', 'e2e/**'],
    rules: { 'react-hooks/rules-of-hooks': 'off' },
  },
);
