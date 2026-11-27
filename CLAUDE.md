# CLAUDE.md

Start by reading [`AGENTS.md`](AGENTS.md) for architecture invariants, BYOK setup/deployment steps, preflight troubleshooting, and provider plugin rules, and [`DEPLOY.md`](DEPLOY.md) for platform guides (Railway, Render, Fly.io, VPS + Caddy, Docker Compose).

Essential commands:

- `npm run doctor` — Non-billable preflight check (DB, `ffmpeg`/`yt-dlp`, S3, public S3 reachability, callback URL, configured AI keys)
- `npm run typecheck && npm run check && npm test` — TypeScript + Biome + 87 unit & provider contract tests
- `npm run build` — Production Next.js standalone build
- `docker compose --profile full up -d --build` — Full container stack with automatic Postgres migrations on boot
