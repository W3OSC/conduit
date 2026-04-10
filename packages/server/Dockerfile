FROM node:20-alpine AS builder
WORKDIR /app
# Build tools required by better-sqlite3 (native module — compiles from source on Alpine)
# git is needed to run `git describe` for the version string
RUN apk add --no-cache python3 make g++ git
COPY package.json package-lock.json ./
COPY packages/server/package.json ./packages/server/
COPY packages/client/package.json ./packages/client/
RUN npm install --workspace=packages/server --workspace=packages/client
COPY packages/server ./packages/server
COPY packages/client ./packages/client
# Copy the .git directory so git describe and git fetch work at runtime
COPY .git ./.git
# Bake the version string into a .version file so the runtime image can read it
# even if git describe were to fail for any reason
RUN git describe --tags --always --dirty=-modified > .version
# Build server
WORKDIR /app/packages/server
RUN npx tsc
# Build client
WORKDIR /app/packages/client
RUN npx vite build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
# git is needed at runtime for `git fetch` (update checking) and `git pull` (apply update)
RUN apk add --no-cache git
COPY --from=builder /app/packages/server/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY packages/server/package.json ./package.json
COPY packages/server/drizzle ./drizzle
# Place the built client where the server expects it: /app/packages/client/dist
COPY --from=builder /app/packages/client/dist ./packages/client/dist
# Copy the .git directory for runtime update checking / git pull
COPY --from=builder /app/.git ./.git
# Copy the baked version file as a fallback
COPY --from=builder /app/.version ./.version
EXPOSE 3101
CMD ["node", "dist/index.js"]
