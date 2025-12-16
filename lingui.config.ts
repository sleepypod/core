import { defineConfig } from '@lingui/cli'

export default defineConfig({
  sourceLocale: 'en-US',
  locales: ['en-US'],
  compileNamespace: 'es',
  catalogs: [
    {
      path: '<rootDir>/locales/{locale}/messages',
      include: ['src'],
    },
  ],
})
