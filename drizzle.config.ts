import { existsSync } from "node:fs";
import { defineConfig } from "drizzle-kit";

// Next.js loads .env itself; drizzle-kit doesn't.
if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./lib/db/migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
