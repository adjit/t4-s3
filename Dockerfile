FROM node:22-bookworm-slim

WORKDIR /app

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

RUN corepack enable && pnpm install --frozen-lockfile && pnpm --filter @t4/web build

ENV T4_DATA_DIR=/data \
    T4_WEB_DIST=/app/apps/web/dist \
    NODE_ENV=production

VOLUME /data
EXPOSE 8080

CMD ["pnpm", "--filter", "@t4/api", "start"]
