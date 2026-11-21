# The harness image: this repo at one commit, with dev dependencies (tsx), so
# the REAL jobs-main and jobs-recover entry points run from source. Built by
# run.sh from a clean clone; not a production image.
FROM node:22-bookworm
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
