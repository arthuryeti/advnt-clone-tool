import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

const { Client } = pg;

const LOCK_ID = 728394112;
const DEFAULT_MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "lib",
  "db",
  "migrations",
);

function redactDbUrl(message, databaseUrl) {
  let out = message;
  try {
    const parsed = new URL(databaseUrl);
    if (parsed.password) {
      out = out.replaceAll(parsed.password, "[REDACTED]");
      out = out.replaceAll(decodeURIComponent(parsed.password), "[REDACTED]");
    }
  } catch {
    // Ignore malformed DATABASE_URL during redaction.
  }
  return out.replace(
    /(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+(@)/giu,
    "$1[REDACTED]$2",
  );
}

async function connectWithRetry(databaseUrl, maxWaitMs = 30_000) {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const client = new Client({ connectionString: databaseUrl });
    try {
      await client.connect();
      return client;
    } catch (error) {
      await client.end().catch(() => undefined);
      if (Date.now() >= deadline) {
        const msg =
          error instanceof Error ? error.message : String(error ?? "unknown");
        throw new Error(
          `Database connection failed after ${Math.round(maxWaitMs / 1000)}s: ${redactDbUrl(msg, databaseUrl)}`,
        );
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

function loadJournalEntries(migrationsDir) {
  const journalPath = resolve(migrationsDir, "meta", "_journal.json");
  if (!existsSync(journalPath)) {
    throw new Error(`Missing Drizzle migration journal at ${journalPath}`);
  }
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  return (journal.entries ?? []).map((entry) => {
    const sqlPath = resolve(migrationsDir, `${entry.tag}.sql`);
    const rawSql = readFileSync(sqlPath, "utf8");
    const statements = rawSql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const hash = createHash("sha256").update(rawSql).digest("hex");
    return {
      tag: entry.tag,
      when: Number(entry.when),
      hash,
      statements,
    };
  });
}

/**
 * Applies pending Drizzle SQL migrations directly using `pg` so standalone production
 * containers migrate automatically on boot without requiring `drizzle-kit`.
 */
export async function runMigrations(options = {}) {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to run database migrations.");
  }
  const migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const entries = loadJournalEntries(migrationsDir);
  const client = await connectWithRetry(databaseUrl, options.maxWaitMs);

  let lockAcquired = false;
  try {
    await client.query(`SELECT pg_advisory_lock(${LOCK_ID})`);
    lockAcquired = true;

    await client.query(`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `);

    const latestResult = await client.query(
      `SELECT created_at FROM "drizzle"."__drizzle_migrations" ORDER BY created_at DESC LIMIT 1`,
    );
    const lastCreatedAt =
      latestResult.rows[0]?.created_at !== undefined &&
      latestResult.rows[0]?.created_at !== null
        ? Number(latestResult.rows[0].created_at)
        : null;

    let appliedCount = 0;
    for (const entry of entries) {
      if (lastCreatedAt !== null && lastCreatedAt >= entry.when) {
        continue;
      }
      await client.query("BEGIN");
      try {
        for (const stmt of entry.statements) {
          await client.query(stmt);
        }
        await client.query(
          `INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ($1, $2)`,
          [entry.hash, entry.when],
        );
        await client.query("COMMIT");
        appliedCount += 1;
        console.info(`[migrate] Applied ${entry.tag}`);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      }
    }

    if (appliedCount === 0) {
      console.info("[migrate] Schema already up to date.");
    }
    return { applied: appliedCount };
  } finally {
    if (lockAcquired) {
      await client
        .query(`SELECT pg_advisory_unlock(${LOCK_ID})`)
        .catch(() => undefined);
    }
    await client.end().catch(() => undefined);
  }
}

const isMain =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  runMigrations().catch((error) => {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[migrate] Failed: ${msg}`);
    process.exit(1);
  });
}
