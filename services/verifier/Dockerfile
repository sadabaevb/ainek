# Ainek verifier image. Build from the repo root: docker build -f services/verifier/Dockerfile -t ainek-verifier .
# Runs TypeScript directly on Node 24 (type stripping), like `pnpm -F verifier start`; no build step.
FROM node:24-slim AS deps
RUN corepack enable && corepack prepare pnpm@10.12.1 --activate
WORKDIR /app
# Every workspace manifest: a frozen lockfile is validated against all importers, not only the filtered one.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/demo/package.json apps/demo/
COPY apps/web/package.json apps/web/
COPY packages/proof/package.json packages/proof/
COPY packages/tier1-node/package.json packages/tier1-node/
COPY services/verifier/package.json services/verifier/
RUN pnpm install --frozen-lockfile --filter verifier...

FROM node:24-slim
WORKDIR /app
# Files are copied as root by default; the daemon runs as `node` and must be able to write data/reports.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=deps --chown=node:node /app/packages/proof/node_modules ./packages/proof/node_modules
COPY --from=deps --chown=node:node /app/services/verifier/node_modules ./services/verifier/node_modules
COPY --chown=node:node packages/proof ./packages/proof
COPY --chown=node:node services/verifier ./services/verifier
COPY --chown=node:node docs/samples ./docs/samples
RUN mkdir -p services/verifier/data/reports && chown -R node:node services/verifier/data
USER node
VOLUME ["/app/services/verifier/data"]
ENTRYPOINT ["node", "services/verifier/src/main.ts"]
