import { runMigrations } from "./migrate.mjs";

async function start() {
  if (process.env.AUTO_MIGRATE !== "false") {
    if (process.env.DATABASE_URL?.trim()) {
      await runMigrations();
    } else {
      console.warn(
        "[entrypoint] DATABASE_URL is not set; skipping automatic migrations.",
      );
    }
  }

  await import("../server.js");
}

start().catch((error) => {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`[entrypoint] Fatal startup error: ${msg}`);
  process.exit(1);
});
