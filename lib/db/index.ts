import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getDatabaseUrl, getNodeEnv } from "@/lib/env";
import * as schema from "./schema";

export type AppDatabase = NodePgDatabase<typeof schema>;

const globalForDatabase = globalThis as typeof globalThis & {
  dbState?: {
    url: string;
    pool: Pool;
    db: AppDatabase;
  };
};

export function getDb(): AppDatabase {
  const url = getDatabaseUrl();
  const current = globalForDatabase.dbState;
  if (current && current.url === url) {
    return current.db;
  }
  if (current) {
    void current.pool.end().catch(() => undefined);
  }
  const pool = new Pool({ connectionString: url });
  const instance = drizzle(pool, { schema });
  if (getNodeEnv() !== "production" || !globalForDatabase.dbState) {
    globalForDatabase.dbState = { url, pool, db: instance };
  } else {
    globalForDatabase.dbState = { url, pool, db: instance };
  }
  return instance;
}

export async function closeDb(): Promise<void> {
  const current = globalForDatabase.dbState;
  globalForDatabase.dbState = undefined;
  if (current) {
    await current.pool.end();
  }
}

export const db: AppDatabase = new Proxy({} as AppDatabase, {
  get(_target, prop, _receiver) {
    const instance = getDb();
    const value = Reflect.get(instance, prop, instance);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});

/** Single tenant: every row belongs to this workspace. */
export const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
