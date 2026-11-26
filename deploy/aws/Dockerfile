FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build:aws

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    ERP_SQLITE_PATH=/data/erp.sqlite
RUN mkdir -p /data && chown node:node /data
COPY --from=build /app/dist/standalone/ ./
COPY --from=build /app/drizzle/ ./drizzle/
USER node
EXPOSE 3000
CMD ["node", "server.js"]
