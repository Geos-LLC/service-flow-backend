module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js', '**/__tests__/**/*.test.js'],
  collectCoverageFrom: [
    'server.js',
    'supabase.js',
    '!node_modules/**'
  ],
  testTimeout: 15000,
};
