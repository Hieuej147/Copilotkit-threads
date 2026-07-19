FROM node:20-alpine AS deps
RUN corepack enable
WORKDIR /workspace
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/thread-client/package.json packages/thread-client/package.json
COPY packages/thread-react/package.json packages/thread-react/package.json
COPY examples/nextjs-copilotkit/package.json examples/nextjs-copilotkit/package.json
RUN pnpm install --filter @threads/example-nextjs... --frozen-lockfile=false

FROM deps AS build
ARG NEXT_PUBLIC_RUNTIME_URL=http://localhost:4000/api/copilotkit
ARG NEXT_PUBLIC_THREAD_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_RUNTIME_URL=$NEXT_PUBLIC_RUNTIME_URL
ENV NEXT_PUBLIC_THREAD_API_URL=$NEXT_PUBLIC_THREAD_API_URL
COPY packages/contracts packages/contracts
COPY packages/thread-client packages/thread-client
COPY packages/thread-react packages/thread-react
COPY examples/nextjs-copilotkit examples/nextjs-copilotkit
RUN pnpm --filter @threads/contracts build && pnpm --filter @threads/client build && pnpm --filter @threads/react build && pnpm --filter @threads/example-nextjs build

FROM node:20-alpine AS runner
RUN corepack enable
WORKDIR /workspace/examples/nextjs-copilotkit
ENV NODE_ENV=production
COPY --from=build /workspace/node_modules /workspace/node_modules
COPY --from=build /workspace/examples/nextjs-copilotkit/node_modules /workspace/examples/nextjs-copilotkit/node_modules
COPY --from=build /workspace/package.json /workspace/package.json
COPY --from=build /workspace/pnpm-workspace.yaml /workspace/pnpm-workspace.yaml
COPY --from=build /workspace/examples/nextjs-copilotkit/.next ./.next
COPY --from=build /workspace/examples/nextjs-copilotkit/public ./public
COPY --from=build /workspace/examples/nextjs-copilotkit/package.json ./package.json
CMD ["./node_modules/.bin/next", "start"]
