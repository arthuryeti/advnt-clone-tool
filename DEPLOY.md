# Deploying Video Clone

Video Clone runs as a **single long-lived Node 24 container** backed by **Postgres** and **S3-compatible object storage** (Cloudflare R2, AWS S3, Tigris, Backblaze B2, or SeaweedFS).

> **Important:** Do **not** deploy to serverless functions (Vercel/Lambda/Workers) or scale horizontally to >1 replica. Long video renders (up to 45 minutes), `ffmpeg` stitching, and `yt-dlp` downloads run inside the container process with Postgres heartbeats and restart reconciliation.

---

## Pre-Deployment Checklist

1. **Postgres 15+** (`DATABASE_URL`). Migrations apply automatically on container boot (`scripts/docker-entrypoint.mjs` -> `scripts/migrate.mjs`) with an advisory lock, or manually via `npm run db:migrate:prod`.
2. **Publicly readable & CORS-enabled S3/R2 bucket** (`S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`):
   - Video generation providers (`kie`, `fal`, `sume`, `revana`) fetch creator faces, product images, and continuity frames directly from signed URLs generated using `S3_PUBLIC_ENDPOINT`.
   - Browser uploads (source videos, faces, product photos) send direct presigned `PUT` requests to `S3_PUBLIC_ENDPOINT` and require CORS on your bucket:

   ```json
   [
     {
       "AllowedOrigins": ["https://your-domain.example.com"],
       "AllowedMethods": ["GET", "PUT", "HEAD"],
       "AllowedHeaders": ["content-type", "content-length"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

3. **Public HTTPS `SITE_URL`:** Required whenever `VIDEO_PROVIDER` uses webhooks (`kie`, `fal`, `sume`). Providers POST completion callbacks to `<SITE_URL>/api/waitpoints/<id>`. (If using `VIDEO_PROVIDER=revana`, polling is used and public callbacks aren't needed.)
4. **BYOK API keys:** Minimum 2 keys:
   - `GEMINI_API_KEY` (automatically handles both video analysis & prompt rewriting), or mix providers (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `SURPLUS_API_KEY`).
   - One video generation key (`FAL_API_KEY`, `KIE_API_KEY`, `REVANA_API_KEY`, or `SUME_API_KEY`) matching `VIDEO_PROVIDER`.
5. **Access protection (recommended):** The app has no built-in login screen. Protect public deployments with Caddy Basic Auth (see [`deploy/Caddyfile`](deploy/Caddyfile)), Cloudflare Access, Tailscale, or HTTP Basic Auth on your proxy — while leaving `/api/waitpoints/*` unauthenticated so video providers can deliver signed webhook callbacks.

---

## Platform Guides

### 1. Railway (`railway.json`)

[`railway.json`](railway.json) configures Dockerfile builds, single-replica deployment, and `/api/waitpoints/health` healthchecks out of the box.

1. Fork or push this repo to GitHub and create a **New Project -> Deploy from GitHub repo** in Railway (or run `railway up` with the Railway CLI).
2. Add a **Postgres** service in the same Railway project.
3. Add an **S3 / Object Storage** service (Cloudflare R2, AWS S3, or Railway Storage Bucket with public presigned access + CORS).
4. Set service **Variables**:
   - `DATABASE_URL=${{Postgres.DATABASE_URL}}`
   - `SITE_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}`
   - `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION=auto`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`
   - `GEMINI_API_KEY` (and optionally `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY`)
   - `VIDEO_PROVIDER=fal` (or `kie` / `revana` / `sume`) and its matching `*_API_KEY`
5. Ensure the service stays at **1 replica** (never multi-replica).
6. Verify deployment readiness:
   ```bash
   curl -i "https://<your-railway-domain>/api/preflight"
   ```

---

### 2. Render (`render.yaml`)

[`render.yaml`](render.yaml) provides a complete Render Blueprint (1 Managed Postgres + 1 Docker Web Service at `numInstances: 1`).

1. In Render Dashboard, choose **New -> Blueprint** and select this repository.
2. Fill in the prompted `sync: false` environment variables:
   - `SITE_URL` (set to your `https://<service>.onrender.com` URL or custom domain once provisioned)
   - `S3_*` credentials + bucket (e.g. Cloudflare R2 or AWS S3)
   - Your BYOK AI keys (`GEMINI_API_KEY` + your chosen video provider key, setting `VIDEO_PROVIDER` if not `kie`)
3. Wait for the health check on `/api/waitpoints/health` to turn green, then verify `https://<your-render-url>/api/preflight` returns HTTP `200`.

---

### 3. Fly.io (`deploy/fly.toml`)

[`deploy/fly.toml`](deploy/fly.toml) pre-configures `min_machines_running = 1`, `auto_stop_machines = "off"` (so renders and webhooks aren't interrupted by idle suspend), and `2gb` RAM for `ffmpeg`.

```bash
# 1. Initialize Fly app from repo root (customize app name/region if needed):
fly launch --copy-config --config deploy/fly.toml --no-deploy

# 2. Attach Postgres (or set an external Managed Postgres DATABASE_URL):
fly postgres create --name video-clone-db
fly postgres attach video-clone-db

# 3. Set runtime secrets (no image rebuild needed to change these later):
fly secrets set \
  SITE_URL="https://<your-app>.fly.dev" \
  S3_ENDPOINT="https://<account-id>.r2.cloudflarestorage.com" \
  S3_PUBLIC_ENDPOINT="https://<account-id>.r2.cloudflarestorage.com" \
  S3_REGION="auto" \
  S3_ACCESS_KEY_ID="..." \
  S3_SECRET_ACCESS_KEY="..." \
  S3_BUCKET="clone-media" \
  GEMINI_API_KEY="..." \
  VIDEO_PROVIDER="kie" \
  KIE_API_KEY="..."

# 4. Deploy single machine (strictly scale count = 1):
fly deploy --config deploy/fly.toml --dockerfile Dockerfile
fly scale count 1 --config deploy/fly.toml

# 5. Verify doctor endpoint:
curl -i "https://<your-app>.fly.dev/api/preflight"
```

---

### 4. VPS / Bare Metal Docker Compose + Caddy (`deploy/docker-compose.vps.yml`)

Runs `app` + `postgres` + Caddy (automatic Let's Encrypt HTTPS) on any Ubuntu/Debian VPS with Docker installed. Use external Cloudflare R2 / AWS S3 (recommended for production) or enable `--profile bundled-s3` for SeaweedFS.

```bash
# On your VPS:
git clone <repo-url> video-clone && cd video-clone
cp .env.example .env
```

Edit `.env` with:
- `DOMAIN=clones.yourdomain.com` (DNS `A` record pointing to your VPS IP)
- `SITE_URL=https://clones.yourdomain.com`
- Strong `POSTGRES_PASSWORD` (and matching `DATABASE_URL=postgresql://clone:<pw>@postgres:5432/clone`)
- Your R2/S3 `S3_*` variables and BYOK AI keys
- Optional Basic Auth (recommended if exposed to the public internet):
  ```bash
  docker run --rm caddy:2-alpine caddy hash-password --plaintext 'choose-a-strong-password'
  ```
  Uncomment the `basic_auth` block in [`deploy/Caddyfile`](deploy/Caddyfile) and add `BASIC_AUTH_USER` + `BASIC_AUTH_HASH` to `.env`. (Notice `/api/waitpoints/*` intentionally bypasses Basic Auth so provider webhooks succeed using waitpoint secrets.)

Launch and verify:

```bash
docker compose -f deploy/docker-compose.vps.yml up -d --build
curl -i "https://clones.yourdomain.com/api/preflight"
```

---

### 5. Coolify / Dokploy / Generic Container Host

- Build context: `.`, Dockerfile: `Dockerfile`, Port: `3000`, Replicas: `1`.
- Health check path: `/api/waitpoints/health`.
- Postgres migrations run automatically at container startup unless `AUTO_MIGRATE=false`.
- All configuration (`SITE_URL`, `S3_*`, `VIDEO_PROVIDER`, API keys) is loaded dynamically at runtime with zero build-time `ARG`s required.

---

## Rotating Keys or Changing `SITE_URL` / Providers

Because nothing is baked at `docker build` time:
1. Update the env vars (`GEMINI_API_KEY`, `FAL_API_KEY`, `VIDEO_PROVIDER`, `SITE_URL`, etc.) in your platform dashboard or `.env`.
2. Restart the container/service (`docker compose ... up -d` or platform restart).
3. Verify `GET /api/preflight` returns HTTP `200` (`ok: true`).
