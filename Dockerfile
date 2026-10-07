FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm ci && npm run build && npm prune --omit=dev

EXPOSE 3000

CMD ["sh", "-c", "node dist/db/migrate.js && node dist/server.js"]
