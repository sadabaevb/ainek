# Ainek verifier image. Build from the repo root: docker build -f services/verifier/Dockerfile -t ainek-verifier .
# Runs TypeScript directly on Node 24 (type stripping), like `pnpm -F verifier start`; no build step.
FROM node:24-slim AS deps
RUN corepack enable && corepack prepare pnpm@10.12.1 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/proof/package.json packages/proof/
COPY services/verifier/package.json services/verifier/
RUN pnpm install --frozen-lockfile --filter verifier...

FROM node:24-slim
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/proof/node_modules ./packages/proof/node_modules
COPY --from=deps /app/services/verifier/node_modules ./services/verifier/node_modules
COPY packages/proof ./packages/proof
COPY services/verifier ./services/verifier
COPY docs/samples ./docs/samples
USER node
ENTRYPOINT ["node", "services/verifier/src/main.ts"]
