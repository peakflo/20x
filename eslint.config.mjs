import tseslint from 'typescript-eslint'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

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
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: __dirname
      }
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }]
    }
  }
)