FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/client/package.json ./packages/client/
RUN npm install --workspace=packages/client
COPY packages/client ./packages/client
WORKDIR /app/packages/client
RUN npx vite build

FROM nginx:alpine
COPY --from=builder /app/packages/client/dist /usr/share/nginx/html
COPY packages/client/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
