# Chore Scout server image (CS-3941).
# Build with the commit SHA; the image refuses to build without it:
#   docker build --build-arg GIT_SHA=$(git rev-parse HEAD) -t chore-scout-server:$(git rev-parse HEAD) .
# Tags are the commit SHA only (no mutable tags). Deployments pin by digest.
# Apple-Silicon hosts must build with --platform linux/amd64 for Fargate (BOB note).

# Base pinned by digest (node:22-alpine as resolved in CI on 4 Nov 2026).
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# DocumentDB TLS (CS-3992): the RDS global CA bundle, verified against a pinned
# SHA-256 (174560 bytes, 114 certificates, as served by AWS on 4 Nov 2026 to a
# GitHub runner, CS-3992). A changed upstream bundle fails the build until the
# pin is reviewed and updated here. The deploy sets MONGODB_TLS_CA_FILE to this path.
RUN mkdir -p /app/certs \
  && wget -qO /app/certs/rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
  && actual="$(sha256sum /app/certs/rds-global-bundle.pem | cut -d' ' -f1)" \
  && pinned="90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b" \
  && if [ "$actual" != "$pinned" ]; then echo "RDS CA bundle checksum mismatch: got $actual, pinned $pinned" >&2; exit 1; fi

FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS runtime
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
COPY --from=build /app/certs ./certs
COPY schema ./schema
# No secrets in the image: MONGODB_URI etc. come from the environment or the
# secrets store (CS_SECRETS_ID) at run time; without them the process exits 78.
# DocumentDB TLS: set MONGODB_TLS_CA_FILE=/app/certs/rds-global-bundle.pem (the
# ECS task definitions in infra/ do).
USER node
EXPOSE 3000
# Same check as the ECS task definition: /ready (database ping) via Node's fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD ["node", "dist/healthcheck.js"]
# API by default. Job process: node dist/jobs-main.js. Migrations: node dist/migrate-main.js.
CMD ["node", "dist/main.js"]
