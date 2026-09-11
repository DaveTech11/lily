FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /app/data /app/downloads

ENV NODE_ENV=production

CMD ["node", "src/main.js"]
