# Stage 1 — build the React shell from the exact frontend dependency tree in
# this commit. Both outputs are deliberately untracked: every production
# deploy, staging preview, local image, and rollback rebuilds them.
FROM node:22-alpine AS shell
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --ignore-scripts
WORKDIR /build
COPY frontend ./frontend
COPY scripts/shell-stamp.js ./scripts/shell-stamp.js
RUN node frontend/scripts/build-shell.mjs

# Stage 2 — compile Tailwind after the shell prerender. public/index.html is a
# Tailwind content source, so copy the freshly rendered document over the
# committed test fixture before compiling. Build dependencies stay in these
# disposable stages.
FROM node:22-alpine AS css
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tailwind.config.js ./
COPY styles ./styles
COPY scripts/build-tailwind.js ./scripts/build-tailwind.js
COPY public ./public
COPY --from=shell /build/public/index.html ./public/index.html
COPY frontend ./frontend
RUN npm run build:css

# Stage 3 — production runtime.
FROM node:22-alpine
# The platform spawns child apps by shelling out to the host's Docker
# daemon (see src/services/docker.js — `execFile('docker', [...])`).
# That needs the docker CLI inside the container; the daemon itself
# is reached via a bind-mounted /var/run/docker.sock from the host.
# git is for the import-existing flow's `git clone` of foreign repos.
# postgresql-client lets DB administration work over the normal Postgres
# Service/network connection in both Docker and Kubernetes modes.
RUN apk add --no-cache docker-cli git postgresql-client
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY . .
# COPY generated assets after the source tree so a developer's ignored local
# builds can never replace the artifacts generated from this image's sources.
COPY --from=shell /build/public/index.html ./public/index.html
COPY --from=shell /build/public/shell/assets/shell.js ./public/shell/assets/shell.js
COPY --from=css /build/public/css/tailwind.css ./public/css/tailwind.css
# docker-compose.dev.yml bind-mounts ./public for live source editing, which
# hides the three generated files above on a clean checkout. Keep a protected
# image copy that its startup helper can restore into that mount when missing.
COPY --from=shell /build/public/index.html /opt/usernode-shell-assets/index.html
COPY --from=shell /build/public/shell/assets/shell.js /opt/usernode-shell-assets/shell/assets/shell.js
COPY --from=css /build/public/css/tailwind.css /opt/usernode-shell-assets/css/tailwind.css
EXPOSE 3000
CMD ["node", "server.js"]
