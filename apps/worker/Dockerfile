FROM node:26.5.1-bookworm-slim@sha256:9e6f9357d371591e32ab6f2d8a26d63bdd0d17c29eee3f4f3e7e454d9634bf73 AS build

RUN npm install --global pnpm@11.20.0
WORKDIR /app
ENV CI=true

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/model-worker/package.json apps/model-worker/package.json
COPY apps/preview-manager/package.json apps/preview-manager/package.json
COPY apps/validation-worker/package.json apps/validation-worker/package.json
COPY apps/temporal-codec/package.json apps/temporal-codec/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/temporal-codec/package.json packages/temporal-codec/package.json
RUN pnpm install --frozen-lockfile

COPY apps/worker apps/worker
COPY packages/contracts packages/contracts
COPY packages/database packages/database
COPY packages/temporal-codec packages/temporal-codec
RUN pnpm --filter @orchestra/contracts build && pnpm --filter @orchestra/database build && pnpm --filter @orchestra/temporal-codec build && pnpm --filter @orchestra/worker build
RUN pnpm --filter @orchestra/worker deploy --prod /deploy/worker

FROM node:26.5.1-bookworm-slim@sha256:9e6f9357d371591e32ab6f2d8a26d63bdd0d17c29eee3f4f3e7e454d9634bf73
WORKDIR /app
ENV NODE_ENV=production
RUN npm uninstall --global npm
COPY --from=build --chown=node:node /deploy/worker ./
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "process.kill(1, 0)"]
CMD ["node", "dist/worker.js"]
