# Video Clone

Paste a TikTok or Instagram video (or upload one) and get a shot-by-shot **clone plan**: the
video split into shots and takes, each with its script and a Seedance prompt. Recast who plays
who with your own faces, put your product in, rewrite the look or the lines in plain words,
render the takes on an AI video provider, and download the stitched edit.

Next.js 16 · tRPC · Drizzle/Postgres · S3-compatible storage · ffmpeg + yt-dlp.

## Run it

Needs Node 24, Docker, `ffmpeg`/`ffprobe` and `yt-dlp` on the PATH (`brew install ffmpeg yt-dlp`).

```bash
cp .env.example .env      # add SURPLUS_API_KEY, and your video provider's key to render
docker compose up -d      # Postgres :5433, SeaweedFS S3 :8333 (bucket clone-media)
npm install
npm run db:migrate
npm run dev
```

## How it works

1. **Analyze** (`trigger/analyze-video-clone.ts`): the link is downloaded with yt-dlp (uploads come
   from storage), ffmpeg proposes cuts, and Gemini (`lib/ai/describe-video.ts`) vets them,
   describes the style, cast, and transcript, and writes one Seedance prompt per take (up to 30s
   each). The plan is saved in `content_templates.structure.video` (schema:
   `lib/content-workflows/video-clone.ts`).
2. **Edit** on the clone page (`components/organization/video-clone-detail.tsx`): edit lines,
   pin product photos per take, pick a model, keep original footage for a take.
3. **Changes** (`trigger/rewrite-video-clone.ts`, `lib/ai/adapt-video-clone-prompts.ts`): free
   text for the whole video ("VHS 80s look", "plug our product and add 30s"). Opus rewrites
   prompts, lines, timing, and can add takes. Nothing renders.
4. **Render** (`trigger/generate-video-clone.ts`): each take goes to the provider with reference
   images (`{{creator}}`/`{{cast:id}}` faces, `{{productN}}` photos, `{{frameN}}` continuity
   frames from earlier renders). Gemini then checks each render against the original.
5. **Stitch** (`trigger/stitch-video-clone.ts`): every part is cut from its render (or the
   original) and joined in story order, plus a copy with the on-screen text burned in.

The page polls while anything runs. Server state lives in `lib/content-workflows/video-clone-store.ts`;
the API is `trpc/routers/`.

## Background jobs

`lib/jobs.ts` runs the four tasks inside the Next.js server process (the same `schemaTask` /
`tasks.trigger` / `wait` calls as Trigger.dev, which the original used). So:

- Deploy as a **long-lived Node server** (`Dockerfile`, any container host). Not serverless:
  renders wait up to 45 minutes.
- One instance. A restart drops running jobs; their takes settle as failed and can be re-rendered.
- KIE and Sume POST finished renders to `NEXT_PUBLIC_SITE_URL/api/waitpoints/<id>`, so that URL
  must be reachable from the internet. In development use a tunnel
  (`cloudflared tunnel --url http://localhost:3000`) and set `NEXT_PUBLIC_SITE_URL` to it.
  Revana is polled and needs no callback.
- Providers fetch reference images from signed storage URLs: production storage (R2, S3) must be
  reachable from the internet, unlike the local SeaweedFS.

## Configuration

See `.env.example`. Text and video understanding go through
[Surplus Intelligence](https://api.surplusintelligence.ai) (`lib/ai/model-policy.ts`); renders
through `VIDEO_PROVIDER` (`kie`, `revana`, or `sume`) with its key. Prices per model and
provider: `VIDEO_CLONE_MODELS` in `lib/content-workflows/video-clone.ts`.

## No auth

There is no login: anyone who can reach the app can use it and spend the provider keys. Put it
behind your own auth or a private network. Every row carries `organization_id` (always
`WORKSPACE_ID` in `lib/db/index.ts`) so plans can be scoped per team later; procedures are in
`trpc/init.ts`.

## Checks

```bash
npm run typecheck && npm run check && npm test
```
