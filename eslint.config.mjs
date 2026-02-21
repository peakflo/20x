import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['out/', 'dist/', 'node_modules/', '*.js', '*.mjs']
  },
  tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['**/*.{ts,tsx}']
  })),
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }]
    }
  }
)