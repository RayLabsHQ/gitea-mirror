import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/lib/db/index.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DATABASE_URL?.replace('file:', '') || 'data/gitea-mirror.db',
  },
  // Generate migrations for SQLite
  verbose: true,
  strict: true,
});