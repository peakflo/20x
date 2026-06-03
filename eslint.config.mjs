import tseslint from 'typescript-eslint'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const languageOptions = {
  parserOptions: {
    tsconfigRootDir: __dirname
  }
}

export default tseslint.config(
  {
    ignores: [
      '**/out/**',
      '**/dist/**',
      '**/node_modules/**',
      '**/*.js',
      '**/*.mjs',
      '**/.claude/**'
    ]
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['**/*.{ts,tsx}', '.claude/**/*.{ts,tsx}'],
    languageOptions: {
      ...config.languageOptions,
      ...languageOptions,
      parserOptions: {
        ...config.languageOptions?.parserOptions,
        ...languageOptions.parserOptions
      }
    }
  })),
  {
    files: ['**/*.{ts,tsx}', '.claude/**/*.{ts,tsx}'],
    languageOptions,
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }]
    }
  }
)