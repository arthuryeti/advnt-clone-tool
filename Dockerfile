# Runs on any long-lived container host. Background jobs (analysis, renders, stitching) run inside
# this Node process, so it needs ffmpeg and yt-dlp, and must not be a serverless function.
ARG NODE_VERSION=24-slim

FROM node:${NODE_VERSION} AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Public variables are compiled into the browser bundle.
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_IMAGES_BUCKET_NAME
ENV NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL} \
    NEXT_PUBLIC_IMAGES_BUCKET_NAME=${NEXT_PUBLIC_IMAGES_BUCKET_NAME} \
    SKIP_ENV_VALIDATION=true
RUN npm run build

FROM node:${NODE_VERSION} AS runner
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
  && if [ "$(dpkg --print-architecture)" = "arm64" ]; then YTDLP=yt-dlp_linux_aarch64; else YTDLP=yt-dlp_linux; fi \
  && curl -fsSL -o /usr/local/bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YTDLP}" \
  && chmod +x /usr/local/bin/yt-dlp \
  && apt-get purge -y curl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/fonts ./fonts
EXPOSE 3000
CMD ["node", "server.js"]
