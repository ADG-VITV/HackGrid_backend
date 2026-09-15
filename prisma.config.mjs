import { loadEnvFile } from "node:process";

import { defineConfig } from "prisma/config";

try {
  loadEnvFile();
} catch {
  // Missing .env is fine in environments that provide DATABASE_URL directly.
}

/**
 * `prisma generate` runs from `npm install` (postinstall) — on a fresh clone
 * and on Render's build step — where no database is needed, so a missing
 * DATABASE_URL must not fail the install. Commands that do connect (`db push`,
 * `studio`) will fail loudly with this placeholder host in the message.
 */
const url =
  process.env.DATABASE_URL ??
  "postgresql://DATABASE_URL-is-not-set@localhost:5432/hackgrid";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "node prisma/seed.mjs",
  },
  datasource: { url },
});
