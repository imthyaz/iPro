# The iPro API image (decision #100). Build from the repository root:
#   docker build -f apps/api/Dockerfile -t ipro-api .
# Runs `node dist/main.js`; the deploy's migrate container runs `node dist/db/migrate-cli.js` first.

FROM node:26.13.0-bookworm-slim AS build
# Node 26 no longer ships corepack: install the repository's exact pnpm.
RUN npm install -g pnpm@10.34.9
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @ipro/api... --filter @ipro/shared
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @ipro/shared build \
 && pnpm --filter @ipro/api build \
 && pnpm --filter @ipro/api deploy --prod --legacy /out

FROM node:26.13.0-bookworm-slim
# RDS requires TLS; the API verifies the server against Amazon's RDS CA bundle (all regions).
# (The directory is made first: ADD --chmod would otherwise give it the file's mode, without x.)
RUN mkdir -p /opt/rds
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /opt/rds/global-bundle.pem
WORKDIR /app
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/drizzle ./drizzle
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_SSL=verify \
    DATABASE_SSL_CA_FILE=/opt/rds/global-bundle.pem
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
