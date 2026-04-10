import type { Config } from 'drizzle-kit';
import path from 'path';

const dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), '../../data/conduit.db');

export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: dbPath,
  },
} satisfies Config;
