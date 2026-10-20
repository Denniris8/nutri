# Bot de Telegram para nutricion_app (grammY)
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN apk add --no-cache tzdata && npm install --omit=dev

COPY . .

CMD ["node", "bot.js"]
