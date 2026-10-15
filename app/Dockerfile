# commit-live GitHub App. Build context: the repo root (app/ reuses src/pages.mjs).
FROM node:22-bookworm-slim
# git: npm ci fetches light-core from its pinned tag, and go-live pushes the Pages branch
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY app ./app
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
USER node
CMD ["node", "app/server.mjs"]
