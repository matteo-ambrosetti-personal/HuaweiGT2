// Minimal lint: catch undefined names and unused code.
const browser = {
  window: 'readonly', document: 'readonly', navigator: 'readonly', location: 'readonly', localStorage: 'readonly',
  getComputedStyle: 'readonly', requestAnimationFrame: 'readonly', ResizeObserver: 'readonly', Blob: 'readonly',
  URL: 'readonly', Worker: 'readonly', WritableStream: 'readonly', TextDecoder: 'readonly', TextEncoder: 'readonly',
  AbortController: 'readonly', Node: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', console: 'readonly',
  structuredClone: 'readonly', self: 'readonly', fetch: 'readonly', Response: 'readonly', crypto: 'readonly',
};
const node = { process: 'readonly', console: 'readonly', Buffer: 'readonly', URL: 'readonly', setTimeout: 'readonly' };

export default [
  {
    files: ['src/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...browser, d3: 'readonly', WORKER_SOURCE: 'readonly' } },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['error', { args: 'none' }], 'no-unreachable': 'error', 'no-dupe-keys': 'error' },
  },
  {
    files: ['scripts/**/*.mjs', 'test/**/*.mjs', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...node, ...browser } },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['error', { args: 'none' }] },
  },
];
