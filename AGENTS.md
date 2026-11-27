# AGENTS.md — Coding Agent Setup, Launch & Deploy Runbook

Follow this runbook whenever a user asks you to set up, troubleshoot, extend, or deploy **Video Clone**.

---

## Non-Negotiable Architecture Invariants

1. **Single-instance Node runtime:** Do **not** recommend or deploy serverless hosts (Vercel/Lambda) or scale replicas > 1. Jobs (`lib/jobs.ts`), crash reconciliation (`lib/render-reconciler.ts`), `ffmpeg`, and `yt-dlp` run inside the single container process.
2. **Pure runtime env (no build args):** Every key, provider choice, `S3_*`, and `SITE_URL` resolves lazily in `lib/env.ts` at request/job time. Never bake keys or `SITE_URL` into `Dockerfile` or `NEXT_PUBLIC_*`.
3. **Never leak or commit `.env` or raw secrets:** Never read `.env` contents into chat logs, never commit `.env` (`.gitignore` / `.dockerignore` exclude it), and keep error strings flowing through `lib/security/redact.ts`.
4. **Migrations are auto-applied in Docker:** Production containers execute `scripts/docker-entrypoint.mjs` -> `scripts/migrate.mjs` automatically on boot unless `AUTO_MIGRATE=false`. Local dev uses `npm run db:migrate`.
5. **Single-file provider extensibility:** Never add `if (provider === ...)` branches in `trigger/`, `trpc/`, `components/`, `lib/env.ts`, `lib/preflight.ts`, or `lib/content-workflows/`. Add new vendors strictly as plugin files under `lib/ai/providers/<plane>/` + their registry + fixture.

---

## Interactive Setup & Deployment Flow

When the user asks you to get the app running or deployed:

### Step 1 — Gather minimal missing inputs (ask concisely, or inspect existing environment)
Ask only for what is missing for the target environment:
1. **Target:** Local dev, local full-stack Docker (`docker compose --profile full up -d --build`), Railway, Render, Fly.io, or VPS (`deploy/docker-compose.vps.yml`).
2. **AI keys (minimum 2):**
   - Analysis + Rewrite: `GEMINI_API_KEY` handles **both** planes by default, or use `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `SURPLUS_API_KEY`.
   - Video generation: choose `VIDEO_PROVIDER` (`kie`, `fal`, `revana`, or `sume`) and collect its matching `*_API_KEY`.
   - Tip: If the user is running locally without a tunnel/public domain and doesn't have R2/S3 yet, suggest `VIDEO_PROVIDER=revana` (`REVANA_API_KEY`, polling-only) or starting local tunnel (`cloudflared tunnel --url http://localhost:3000`).
3. **Storage & URL (for cloud/production):**
   - S3/R2 bucket details (`S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`) with browser CORS allowing the app's origin.
   - Public HTTPS `SITE_URL`.

### Step 2 — Configure & Verify Locally (if running on this machine)

1. Check port availability before starting `docker compose`:
   - Default Postgres host port is `5433`, SeaweedFS S3 is `8333`, App is `3000`.
   - If `5433` is already in use, set `POSTGRES_PORT=5434` (or another free port) and match it in `DATABASE_URL`.
2. **Local dev workflow:**
   ```bash
   docker compose up -d
   npm install
   npm run db:migrate
   npm run doctor
   npm run dev
   ```
3. **Full Docker Compose workflow:**
   ```bash
   docker compose --profile full up -d --build
   curl -i http://127.0.0.1:3000/api/preflight
   ```
   > Note: `app` in `docker-compose.yml` uses `PREFLIGHT_ALLOW_LOCAL_URLS=true` by default so local `s3:8333` and `http://127.0.0.1:3000` pass `api/preflight`. For real remote webhook providers (`kie`, `fal`, `sume`) in local Docker, override `SITE_URL` and `S3_PUBLIC_ENDPOINT` to public HTTPS tunnel/R2 URLs.

### Step 3 — Deploy to User's Chosen Cloud Target (following `DEPLOY.md`)

- **Railway:** Push repo / `railway up`, attach Postgres + S3/R2, set env vars from `.env.example` (single replica; `railway.json` sets `/api/waitpoints/health`).
- **Render:** Connect repo as Blueprint (`render.yaml`), fill `sync: false` secrets, ensure `numInstances: 1`.
- **Fly.io:** `fly launch --copy-config --config deploy/fly.toml --no-deploy`, create/attach Postgres, `fly secrets set ...`, `fly deploy --config deploy/fly.toml --dockerfile Dockerfile`, `fly scale count 1`.
- **VPS:** Configure `.env` with `DOMAIN`, `SITE_URL=https://$DOMAIN`, R2/S3, BYOK keys, optionally uncomment Basic Auth in `deploy/Caddyfile`, and run `docker compose -f deploy/docker-compose.vps.yml up -d --build`.

### Step 4 — Mandatory Verification Gate (`GET /api/preflight`)

Before telling the user deployment is done, verify:
1. `<SITE_URL>/api/waitpoints/health` returns `200 {"ok":true}`.
2. `<SITE_URL>/api/preflight` (or `npm run doctor`) returns `200 {"ok":true,...}`.
3. If `ok: false`, map failing `checks[].name`:
   - `database`: Verify `DATABASE_URL`, VPC/private networking, and SSL mode if external Postgres requires it.
   - `binaries`: Only fails outside the provided `Dockerfile` (install `ffmpeg`, `ffprobe`, `yt-dlp`).
   - `storage_s3`: Verify bucket exists and `S3_ENDPOINT` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_BUCKET` match.
   - `s3_public_reachability`: Set `S3_PUBLIC_ENDPOINT` to a publicly reachable URL (or `PREFLIGHT_ALLOW_LOCAL_URLS=true` for local-only tests).
   - `callback_url`: Set `SITE_URL` to the public HTTPS domain of the app (without trailing slash) and verify `/api/waitpoints/*` bypasses any proxy Basic Auth.
   - `video_generation_provider` / `video_analysis_provider` / `text_provider`: Invalid or missing API key (`errorKind: "auth"`) — confirm the right key env var is set for the active provider.

---

## Extending Providers (Recipe)

To add a new video vendor `<id>` (e.g. Runway, Luma, Kling):
1. Capture sanitized request/response/error/webhook payloads in `lib/ai/fixtures/<id>.json`.
2. Implement `VideoGenerationProvider` in `lib/ai/providers/video/<id>.ts` (follow `lib/ai/providers/video/fal.ts`), using `fetchJsonWithTimeout` (`isBillableSubmit: true` on `submit`, `withBackoffRetry` only on idempotent `getStatus`), Zod response schemas, and `downloadVideo`.
3. Register the provider in `lib/ai/providers/video/registry.ts` (1 import + 1 array entry).
4. Verify automatic coverage across all checks:
   ```bash
   npm run check:write && npm run typecheck && npm run check && npm test && npm run build
   ```
