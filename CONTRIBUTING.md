# Contributing

Contributions are welcome — especially new AI provider adapters, model pricing updates, and bug fixes.

## Local Development Setup

Prerequisites: Node 24+, Docker, `ffmpeg`/`ffprobe`, and `yt-dlp`.

```bash
cp .env.example .env
docker compose up -d          # Postgres :5433 + SeaweedFS S3 :8333 (use POSTGRES_PORT=5434 if 5433 is busy)
npm install
npm run db:migrate
npm run dev
```

## Adding an AI Provider Plugin

Providers live completely isolated in `lib/ai/providers/`:

- **Video Generation:** Implement `VideoGenerationProvider` ([`lib/ai/providers/video/types.ts`](lib/ai/providers/video/types.ts)) in `lib/ai/providers/video/<provider>.ts` (see [`fal.ts`](lib/ai/providers/video/fal.ts)) and register it in [`registry.ts`](lib/ai/providers/video/registry.ts).
- **Video Understanding:** Implement `VideoUnderstandingProvider` in `lib/ai/providers/video-understanding/` and register in `registry.ts`.
- **Text / Structured Outputs:** Implement `TextProvider` in `lib/ai/providers/text/` and register in `registry.ts`.

Requirements for every new provider PR:
1. Add sanitized wire fixtures at `lib/ai/fixtures/<provider>.json` (using dummy keys/URLs — never real credentials).
2. Validate responses with Zod (`zod/v4`) and classify HTTP/body failures using [`lib/ai/errors.ts`](lib/ai/errors.ts).
3. Pass `isBillableSubmit: true` on `submit` calls and **never** retry billable submissions automatically; retry idempotent `getStatus` polls only via `withBackoffRetry`.
4. Download remote media via [`lib/storage/download-video.ts`](lib/storage/download-video.ts) so SSRF blocking, size limits, and timeouts are enforced.
5. Make zero changes to `trigger/`, `trpc/`, `components/`, `lib/content-workflows/`, `lib/env.ts`, or `lib/preflight.ts`.

## Verification Checklist

All checks must pass with zero warnings before opening a PR:

```bash
npm run check:write
npm run typecheck
npm run check
npm test
npm run build
```

If you modified DB persistence, orchestration, or storage code, also run the integration suite against Docker Postgres + SeaweedFS:

```bash
POSTGRES_PORT=5439 S3_PORT=8339 docker compose -p video-clone-int up -d
DATABASE_URL=postgresql://clone:clone@127.0.0.1:5439/clone npm run db:migrate
DATABASE_URL=postgresql://clone:clone@127.0.0.1:5439/clone S3_ENDPOINT=http://127.0.0.1:8339 npm run test:integration
docker compose -p video-clone-int down -v
```
