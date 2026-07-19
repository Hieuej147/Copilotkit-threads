FROM node:20-alpine AS deps
RUN corepack enable
WORKDIR /workspace
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY apps/runtime/package.json apps/runtime/package.json
RUN pnpm install --filter @threads/runtime... --frozen-lockfile=false

FROM deps AS build
COPY packages/contracts packages/contracts
COPY apps/runtime apps/runtime
COPY infra infra
RUN pnpm --filter @threads/contracts build && pnpm --filter @threads/runtime build

FROM node:20-alpine AS runner
RUN corepack enable
WORKDIR /workspace
ENV NODE_ENV=production
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/packages/contracts ./packages/contracts
COPY --from=build /workspace/apps/runtime ./apps/runtime
COPY --from=build /workspace/infra ./infra
CMD ["node", "apps/runtime/dist/server.js"]
