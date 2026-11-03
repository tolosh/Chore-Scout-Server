# Chore Scout server image (CS-3941).
# Build with the commit SHA; the image refuses to build without it:
#   docker build --build-arg GIT_SHA=$(git rev-parse HEAD) -t chore-scout-server:$(git rev-parse HEAD) .
# Tags are the commit SHA only (no mutable tags). Deployments pin by digest.
# Apple-Silicon hosts must build with --platform linux/amd64 for Fargate (BOB note).

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
ARG GIT_SHA
RUN test -n "$GIT_SHA" && echo "$GIT_SHA" | grep -Eq '^[0-9a-f]{40}$' \
  || (echo "GIT_SHA build arg must be the full 40-character commit SHA" >&2; exit 1)
WORKDIR /app
ENV NODE_ENV=production \
    GIT_SHA=$GIT_SHA
LABEL org.opencontainers.image.revision=$GIT_SHA \
      org.opencontainers.image.source=https://github.com/tolosh/chore-scout-server \
      org.opencontainers.image.title=chore-scout-server
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY schema ./schema
# No secrets in the image: MONGODB_URI etc. come from the environment or the
# secrets store (CS_SECRETS_ID) at run time; without them the process exits 78.
# DocumentDB TLS: mount or add the RDS CA bundle and set MONGODB_TLS_CA_FILE once hosting is decided (G3).
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1
# API by default. Job process: node dist/jobs-main.js. Migrations: node dist/migrate-main.js.
CMD ["node", "dist/main.js"]
