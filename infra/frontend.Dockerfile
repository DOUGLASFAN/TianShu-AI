FROM node:24-alpine AS build
WORKDIR /workspace/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend ./
COPY assets/branding /workspace/assets/branding
COPY assets/earth /workspace/assets/earth
COPY assets/models /workspace/assets/models
RUN npm run prepare-assets && npm run build
FROM nginx:alpine
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/frontend/dist /usr/share/nginx/html
