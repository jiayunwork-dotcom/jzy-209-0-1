# Multi-stage build for the vacuum network calculation service.
FROM node:20-bookworm-slim AS build
WORKDIR /app

# Install dependencies using the committed lockfile when present.
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Runtime image: only production dependencies and compiled output.
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

COPY --from=build /app/dist ./dist
# SQL migrations are read from the compiled tree; keep the source copy in sync.
COPY src/storage/migrations ./dist/storage/migrations

EXPOSE 3000
USER node
CMD ["node", "dist/server.js"]
