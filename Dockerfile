# --- 1. faza: gradnja frontenda ---
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.ts vite.preview.config.ts tsconfig.json postcss.config.js tailwind.config.js ./
COPY src ./src
RUN npm run build

# --- 2. faza: produkcijski strežnik ---
FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev --no-audit --no-fund
COPY server ./server
COPY --from=build /app/dist ./dist
ENV DATA_DIR=/data
ENV DIST_DIR=/app/dist
ENV PORT=8090
VOLUME /data
EXPOSE 8090
CMD ["node", "server/index.js"]
