import dotenv from 'dotenv'
import { defineConfig, env } from 'prisma/config'

type Env = {
  DATABASE_URL: string
}

const targetEnv = process.env.NODE_ENV || 'dev'
dotenv.config({
  path: `.env.${targetEnv}`,
})

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env<Env>('DATABASE_URL'),
  },
})
