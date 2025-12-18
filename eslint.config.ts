import css from '@eslint/css'
import { default as eslint } from '@eslint/js'
import json from '@eslint/json'
import stylistic from '@stylistic/eslint-plugin'
import nextVitals from 'eslint-config-next/core-web-vitals'
import pluginReact from 'eslint-plugin-react'
import { includeIgnoreFile } from '@eslint/compat'
import { defineConfig, globalIgnores } from 'eslint/config'
import { fileURLToPath } from 'node:url'
import tseslint from 'typescript-eslint'

const gitignorePath = fileURLToPath(new URL('.gitignore', import.meta.url))

export default defineConfig(...[
  {
    settings: {
      react: {
        version: 'detect',
      },
    },
  },
  eslint.configs.recommended,
  stylistic.configs.recommended,
  tseslint.configs.strict,
  pluginReact.configs.flat.recommended,
  ...nextVitals,
  includeIgnoreFile(gitignorePath),
  globalIgnores([
    'build/**',
    'dist/**',
    'next-env.d.ts',
    'out/**',
    'generated/**',
  ]),
  {
    files: ['**/*.jsonc'],
    plugins: { json },
    language: 'json/jsonc',
    extends: ['json/recommended'],
  },
  {
    files: ['**/*.css'],
    plugins: { css },
    language: 'css/css',
    extends: ['css/recommended'],
  },
])
