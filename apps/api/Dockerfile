# API 构建（NestJS 11 + Drizzle）
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
# migration SQL（启动时 migrate 读取）
COPY --from=build /app/drizzle ./drizzle
EXPOSE 3000
CMD ["node", "dist/main"]
