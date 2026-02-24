import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/db/biometrics-schema.ts',
  out: './src/db/biometrics-migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.BIOMETRICS_DATABASE_URL || 'file:./biometrics.db',
  },
})
