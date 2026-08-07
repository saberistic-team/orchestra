FROM node:26.5.0-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb AS build

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

COPY apps/temporal-codec apps/temporal-codec
COPY packages/temporal-codec packages/temporal-codec
RUN pnpm --filter @orchestra/temporal-codec build && pnpm --filter @orchestra/temporal-codec-server build
RUN pnpm --filter @orchestra/temporal-codec-server deploy --prod /deploy/temporal-codec

FROM node:26.5.0-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb
WORKDIR /app
ENV NODE_ENV=production
RUN npm uninstall --global npm
COPY --from=build --chown=node:node /deploy/temporal-codec ./
USER node
EXPOSE 8888
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://localhost:8888/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
