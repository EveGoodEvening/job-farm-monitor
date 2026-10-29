# Railway image: Node 24 + node:sqlite, serves the API and the web dashboard.
# Build: docker build -t job-farm-monitor .
# Run:   docker run -e READ_TOKEN=.. -e WRITE_TOKENS=host:tok -v "$PWD/tmpdata:/data" -p 127.0.0.1:8080:8080 job-farm-monitor

# Multi-architecture digest: update deliberately with .nvmrc and package.json.
# Node's bundled trust store and Alpine's system CA store are separate.
FROM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS base
RUN apk add --no-cache ca-certificates=20261020-r0 \
    && npm install --global npm@12.2.1 \
    && npm cache clean --force

FROM base AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY local/package.json local/
RUN npm ci
COPY tsconfig.base.json vitest.shared.ts ./
COPY packages/core packages/core
COPY packages/server packages/server
COPY packages/web packages/web
RUN npm run build

FROM base AS runtime
WORKDIR /app
# Railway sets RAILWAY_VOLUME_MOUNT_PATH to the attached volume at runtime;
# /data is the default for plain `docker run -v ...:/data`.
ENV NODE_ENV=production \
    PORT=8080 \
    RAILWAY_VOLUME_MOUNT_PATH=/data
COPY package.json package-lock.json .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY local/package.json local/
RUN npm ci --omit=dev --workspace=@jfm/server --include-workspace-root=false \
    && npm cache clean --force
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/web/dist packages/web/dist
# Runs as root: Railway mounts volumes root-owned.
RUN mkdir -p /data
# No VOLUME instruction: Railway rejects it; attach a Railway volume at /data instead.
EXPOSE 8080
CMD ["node", "packages/server/dist/entry.node.js"]
