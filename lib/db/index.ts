import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "@/lib/env";
import * as schema from "./schema";

const globalForDatabase = globalThis as typeof globalThis & { pool?: Pool };
const pool =
  globalForDatabase.pool ?? new Pool({ connectionString: env.DATABASE_URL });
if (env.NODE_ENV !== "production") globalForDatabase.pool = pool;

export const db = drizzle(pool, { schema });

/** Single tenant: every row belongs to this workspace. */
export const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
