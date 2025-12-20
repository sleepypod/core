import { default as eslint } from '@eslint/js'
import stylistic from '@stylistic/eslint-plugin'
import nextVitals from 'eslint-config-next/core-web-vitals'
import pluginReact from 'eslint-plugin-react'
import { defineConfig, globalIgnores } from 'eslint/config'
import tseslint from 'typescript-eslint'

export default defineConfig([
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
      },
    },
  },
  {
    settings: {
      react: { version: 'detect' },
    },
  },
  eslint.configs.recommended,
  stylistic.configs.recommended,
  tseslint.configs.strict,
  pluginReact.configs.flat.recommended,
  ...nextVitals,

  globalIgnores([
    '.next/**',
    'build/**',
    'coverage/**',
    'dist/**',
    'generated/**',
    'next-env.d.ts',
    'out/**',
  ]),

  /** Global JS overrides */
  {
    rules: {
      '@stylistic/comma-dangle': ['error', 'only-multiline'],
      '@stylistic/no-multiple-empty-lines': ['error', { max: 1, maxEOF: 1 }],
    },
  },

  /** Type-aware rules applied ONLY to TypeScript files */
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
    }
  },

  /** File specific overrides */
  {
    files: ['src/app/**', 'src/slices/**', '**/**.stories.*'],
    rules: {
      'import/no-default-export': 'off',
    },
  },
])
