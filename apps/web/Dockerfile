# The iPro web app image (decision #100): the built app served by nginx, unprivileged, on port 8080.
# Build from the repository root:
#   docker build -f apps/web/Dockerfile -t ipro-web .

FROM node:26.13.0-bookworm-slim AS build
# Node 26 no longer ships corepack: install the repository's exact pnpm.
RUN npm install -g pnpm@10.34.9
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @ipro/web... --filter @ipro/shared
COPY packages/shared packages/shared
COPY apps/web apps/web
# Only the bundle: CI typechecks everything, including the e2e tests that need the API test helpers.
RUN pnpm --filter @ipro/shared build && pnpm --filter @ipro/web exec vite build

FROM nginxinc/nginx-unprivileged:1.28.0-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
