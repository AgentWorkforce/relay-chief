# Image contract: non-root, read-only root filesystem compatible, and provides
# `node` plus /opt/relay-chief/dist/cli.js. State, config and /tmp are mounted by
# the deployment. Credentials are injected at runtime, never built in.
FROM node:24-bookworm-slim AS build
WORKDIR /opt/relay-chief
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /opt/relay-chief
COPY --from=build /opt/relay-chief/package.json ./package.json
COPY --from=build /opt/relay-chief/node_modules ./node_modules
COPY --from=build /opt/relay-chief/dist ./dist
# Numeric so Kubernetes runAsNonRoot can verify it (the image's `node` user).
USER 1000:1000
CMD ["node", "/opt/relay-chief/dist/cli.js"]
