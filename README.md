# Video Clone

An open-source, self-hostable AI video cloning studio. Paste a TikTok or Instagram URL (or upload a video) to break it into shots and takes, swap faces and product photos, rewrite scripts or style in plain English, render individual takes or single shots on your own AI video API keys, verify visual continuity, and export a stitched final edit.

Built on a single-container **Next.js 16 + tRPC + Drizzle/Postgres + S3 + ffmpeg + yt-dlp** stack with zero external queue workers, durable crash reconciliation, SSRF protection, secret redaction, and single-file BYOK provider plugins.

---

## Quickstart

Pick whichever path fits you best: **let your AI agent set it up**, **boot the whole stack in Docker**, or **run locally in dev mode**.

### Option A — Tell your coding agent to set up & deploy it

Open this repo in Claude Code, Codex, Cursor, or Antigravity and paste:

```text
Read AGENTS.md and DEPLOY.md, then help me configure my BYOK API keys, verify `npm run doctor` / `/api/preflight`, and deploy or launch this Video Clone instance.
```

[AGENTS.md](AGENTS.md) and [DEPLOY.md](DEPLOY.md) contain the complete interactive checklist, prebuilt platform configs (`railway.json`, `render.yaml`, `deploy/fly.toml`, `deploy/docker-compose.vps.yml`), and health verification steps.

---

### Option B — One-command Docker stack (no Node/ffmpeg install needed)

1. Configure your keys (minimum 2 keys: `GEMINI_API_KEY` + one video provider key like `FAL_API_KEY`, `KIE_API_KEY`, `REVANA_API_KEY`, or `SUME_API_KEY`):

   ```bash
   cp .env.example .env
   # Edit .env with your keys (no need to touch DATABASE_URL or S3_* for Compose).
   ```

2. Build and start Postgres, SeaweedFS S3 (auto-creates `clone-media`), auto-migrations, and the app:

   ```bash
   docker compose --profile full up -d --build
   ```

   > If host port `5433`, `8333`, or `3000` is already bound on your machine, prefix overrides such as:
   > `POSTGRES_PORT=5434 S3_PORT=8334 APP_PORT=3001 docker compose --profile full up -d --build`

3. Open **http://localhost:3000** and verify setup readiness at **http://localhost:3000/api/preflight**.

---

### Option C — Local development (Node + Docker infra)

Prerequisites: **Node 24+**, **Docker**, **`ffmpeg`/`ffprobe`**, and **`yt-dlp`** on `PATH` (macOS: `brew install ffmpeg yt-dlp`).

```bash
cp .env.example .env            # add your BYOK API keys
docker compose up -d            # Postgres :5433 + SeaweedFS S3 :8333
npm install
npm run db:migrate              # apply Drizzle migrations
npm run doctor                  # non-billable preflight check
npm run dev                     # http://localhost:3000
```

> **Note on local ports & webhooks:**
> - If another project already binds host port `5433`, start Compose with `POSTGRES_PORT=5434 docker compose up -d` and update `DATABASE_URL` in `.env` to port `5434`.
> - **Webhook providers** (`kie`, `fal`, `sume`) require `SITE_URL` to be reachable from the internet (`cloudflared tunnel --url http://localhost:3000`) and reference images in `S3_PUBLIC_ENDPOINT` to be publicly downloadable (e.g., Cloudflare R2 in production or an S3 tunnel).
> - **Polling-only testing:** Set `VIDEO_PROVIDER=revana` with `REVANA_API_KEY` to test locally with zero webhook tunnels.

---

## Bring Your Own Keys (BYOK)

No vendor lock-in: every AI plane resolves keys lazily from `process.env` at runtime. You can swap API keys, providers, models, or `SITE_URL` by restarting the process/container with updated environment variables — **never rebuild the Docker image**. Unused providers never crash startup.

### Plane 1 — Video Understanding (`analyze` & render mismatch verification)

Auto-selects in priority order if `VIDEO_ANALYSIS_PROVIDER` is omitted:

| Provider ID | Key Env Var | Default Model (`VIDEO_ANALYSIS_MODEL`) | Optional Base URL Override |
| --- | --- | --- | --- |
| `gemini` | `GEMINI_API_KEY` | `gemini-2.5-flash` | `GEMINI_BASE_URL` |
| `openrouter` | `OPENROUTER_API_KEY` | `google/gemini-2.5-flash` | `OPENROUTER_BASE_URL` |
| `surplus` | `SURPLUS_API_KEY` | `gemini-3.8-flash` | `SURPLUS_BASE_URL` |

### Plane 2 — Text & Structured Outputs (`rewrite` & prompt adaptation)

Auto-selects in priority order if `TEXT_PROVIDER` is omitted (setting only `GEMINI_API_KEY` covers both Plane 1 and Plane 2):

| Provider ID | Key Env Var | Default Model (`TEXT_MODEL`) | Optional Base URL Override |
| --- | --- | --- | --- |
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-5` | `ANTHROPIC_BASE_URL` |
| `openai` | `OPENAI_API_KEY` | `gpt-4.1` | `OPENAI_BASE_URL` (any OpenAI-compatible API) |
| `openrouter` | `OPENROUTER_API_KEY` | `anthropic/claude-sonnet-4.5` | `OPENROUTER_BASE_URL` |
| `gemini` | `GEMINI_API_KEY` | `gemini-2.5-flash` | `GEMINI_BASE_URL` |
| `surplus` | `SURPLUS_API_KEY` | `claude-opus-5.5` | `SURPLUS_BASE_URL` |

### Plane 3 — Video Generation (`render`)

Selected via `VIDEO_PROVIDER` (default `kie`):

| Provider ID (`VIDEO_PROVIDER`) | Key Env Var | Delivery Mode | Callback Required? | Supported Canonical Models |
| --- | --- | --- | --- | --- |
| `kie` | `KIE_API_KEY` | Webhook + Poll | Yes (`SITE_URL`) | `seedance-2.5`, `wan-3.0` |
| `fal` | `FAL_API_KEY` | Webhook + Poll | Yes (`SITE_URL`) | `seedance-2.5`, `wan-3.0` |
| `revana` | `REVANA_API_KEY` | Polling + `Idempotency-Key` | No | `seedance-2.5`, `wan-3.0` |
| `sume` | `SUME_API_KEY` | Webhook + Poll + `Idempotency-Key` | Yes (`SITE_URL`) | `seedance-2.5`, `wan-3.0` |

---

## Preflight / Doctor Check

Before spending credits on any render or analysis, verify your configuration with a **non-billable** check:

```bash
npm run doctor
# Or hit GET /api/preflight in a running instance
```

`GET /api/preflight` returns HTTP `200` when ready (or `503` with actionable details if any check fails) covering:
- `database` — Postgres connectivity
- `binaries` — `ffmpeg`, `ffprobe`, and `yt-dlp` on `PATH`
- `storage_s3` — S3 bucket existence & credentials
- `s3_public_reachability` — Public signed URL round-trip probe from `S3_PUBLIC_ENDPOINT`
- `callback_url` — Waitpoint webhook health probe at `<SITE_URL>/api/waitpoints/health` (when the active video provider uses webhooks)
- `video_generation_provider`, `video_analysis_provider`, `text_provider` — Non-billable key/auth verification

In local non-public Docker/dev environments where you only want to test API credentials with local S3/`localhost` URLs, set `PREFLIGHT_ALLOW_LOCAL_URLS=true`.

---

## Deploying to Production

See **[DEPLOY.md](DEPLOY.md)** for full step-by-step deployment instructions, S3/R2 CORS setup, and access protection. Ready-to-use manifests are included for:

- **Railway:** [`railway.json`](railway.json)
- **Render:** [`render.yaml`](render.yaml)
- **Fly.io:** [`deploy/fly.toml`](deploy/fly.toml)
- **VPS / Coolify / Dokploy (Docker Compose + Caddy HTTPS):** [`deploy/docker-compose.vps.yml`](deploy/docker-compose.vps.yml) + [`deploy/Caddyfile`](deploy/Caddyfile)

### Production Rules to Keep in Mind

1. **Single long-lived Node instance only:** Background tasks (`analyze`, `rewrite`, `render`, `stitch`) run inside the container (`lib/jobs.ts`) with heartbeats and restart reconciliation (`instrumentation.ts`, `lib/render-reconciler.ts`). Do **not** deploy to serverless platforms (Vercel Functions, Cloudflare Workers) or scale horizontally past `1` replica.
2. **Database migrations run automatically:** The production container entrypoint (`scripts/docker-entrypoint.mjs` -> `scripts/migrate.mjs`) acquires a Postgres advisory lock, applies pending Drizzle migrations on boot, and starts Next.js. (Set `AUTO_MIGRATE=false` if you run `npm run db:migrate:prod` externally.)
3. **Public S3/R2 + public HTTPS `SITE_URL`:** Remote video providers fetch reference faces/products via signed URLs (`S3_PUBLIC_ENDPOINT`) and deliver webhook results to `<SITE_URL>/api/waitpoints/<id>`.
4. **Add an access gate before exposing publicly:** There is no built-in user login (`trpc/init.ts`). Put the app behind Caddy Basic Auth (snippet included in [`deploy/Caddyfile`](deploy/Caddyfile)), Cloudflare Access, Tailscale, or a VPN. Keep `/api/waitpoints/*` unauthenticated at the reverse proxy — webhooks use per-attempt cryptographic waitpoint tokens.

---

## Adding a New AI Provider Plugin

Every video generation vendor lives in **one self-contained adapter file** implementing `VideoGenerationProvider` ([`lib/ai/providers/video/types.ts`](lib/ai/providers/video/types.ts)) plus a 1-line registration in [`lib/ai/providers/video/registry.ts`](lib/ai/providers/video/registry.ts) — no changes to `trigger/`, `trpc/`, `components/`, `lib/env.ts`, or `lib/preflight.ts`.

Look at [`lib/ai/providers/video/fal.ts`](lib/ai/providers/video/fal.ts) and [`lib/ai/fixtures/fal.json`](lib/ai/fixtures/fal.json) for a reference implementation. Once you add a sanitized wire fixture at `lib/ai/fixtures/<id>.json` and register your provider, `npm test` automatically runs the **Shared Provider Contract Test Suite** against it (happy path, malformed responses, HTTP-200 failure envelopes, 401 fail-fast, 429 `Retry-After`, 5xx backoff, ambiguous submit timeout non-duplication, forged/replayed webhook checks, SSRF blocking, and secret redaction).

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on adding Video Generation, Video Understanding, or Text provider adapters.

---

## How the Pipeline Works & Hardening Guarantees

1. **Analyze** (`trigger/analyze-video-clone.ts`): Downloads social links via `yt-dlp` (with process timeout) or reads uploaded storage clips, proposes cuts via `ffmpeg`, analyzes shots/cast/dialogue via the active Video Understanding plugin (`lib/ai/describe-video.ts`), and stores the plan in Postgres (`content_templates`).
2. **Edit & Rewrite** (`components/organization/video-clone-detail.tsx`, `trigger/rewrite-video-clone.ts`): Recast faces, pin product photos, edit lines, pick canonical models, or rewrite the plan in plain English via the Text plugin (`lib/ai/adapt-video-clone-prompts.ts`) under Postgres `SELECT ... FOR UPDATE` locks.
3. **Render** (`trigger/generate-video-clone.ts`, `lib/render-reconciler.ts`): Persists each take/shot render in `render_attempts` + `job_waitpoints` before calling the provider so restarts or dropped webhooks resume cleanly without double-submitting billable requests. Ambiguous submit timeouts stay in `"ambiguous"` rather than auto-retrying.
4. **Stitch** (`trigger/stitch-video-clone.ts`): Cuts and stitches takes/parts with `ffmpeg`, optionally burning caption overlays, using monotonic `edit.revision` checks and coalesced queues so parallel completions cannot overwrite newer edits.
5. **Security & Isolation**: Secret redaction (`lib/security/redact.ts`) scrubs API keys from logs, Postgres error columns, and tRPC errors; download SSRF validation (`lib/security/ssrf.ts`, `lib/storage/download-video.ts`) blocks private/loopback/IMDS/DNS-rebind URLs and caps downloads at 50 MB.

---

## Checks & Tests

```bash
npm run typecheck          # TypeScript strict check
npm run check              # Biome lint + format check
npm test                   # Unit tests + Shared Provider Contract Suite (87 tests)
npm run test:integration   # Crash-recovery & SeaweedFS/Postgres fault-injection tests (requires Docker on 5439/8339 or custom env)
npm run build              # Production Next.js standalone build
```

## License

[MIT](LICENSE)
