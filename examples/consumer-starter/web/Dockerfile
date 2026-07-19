FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json ./
RUN pnpm install --frozen-lockfile=false
COPY . .
ARG NEXT_PUBLIC_RUNTIME_URL
ARG NEXT_PUBLIC_THREAD_API_URL
ENV NEXT_PUBLIC_RUNTIME_URL=$NEXT_PUBLIC_RUNTIME_URL NEXT_PUBLIC_THREAD_API_URL=$NEXT_PUBLIC_THREAD_API_URL
RUN pnpm build

FROM node:22-alpine
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
USER node
CMD ["./node_modules/.bin/next", "start"]
