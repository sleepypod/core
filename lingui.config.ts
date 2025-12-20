import { defineConfig } from '@lingui/cli'

const config = defineConfig({
  locales: ['en', 'es', 'pseudo'],
  pseudoLocale: 'pseudo',
  sourceLocale: 'en',
  fallbackLocales: {
    default: 'en',
  },
  catalogs: [
    {
      path: 'src/lib/i18n/locales/{locale}',
      include: ['src', 'app'],
      exclude: ['**/node_modules/**', '**/dist/**']
    },
  ],
})

export default config
