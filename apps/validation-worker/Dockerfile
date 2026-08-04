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
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
RUN pnpm install --frozen-lockfile
COPY apps/validation-worker apps/validation-worker
COPY packages/contracts packages/contracts
RUN pnpm --filter @orchestra/contracts build && pnpm --filter @orchestra/validation-worker build
RUN pnpm --filter @orchestra/validation-worker deploy --prod /deploy/validation-worker

FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=pwuser:pwuser /deploy/validation-worker ./
USER pwuser
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "-e", "process.kill(1, 0)"]
CMD ["node", "dist/validation-worker.js"]
