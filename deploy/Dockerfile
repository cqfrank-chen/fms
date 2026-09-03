# nginx + 前端静态产物
FROM node:22-alpine AS web-build
WORKDIR /web
COPY apps/web/package*.json ./
RUN npm install
COPY apps/web/ .
RUN npm run build

FROM nginx:alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /web/dist /usr/share/nginx/html
EXPOSE 80
