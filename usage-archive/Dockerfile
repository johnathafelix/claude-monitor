FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV PORT=3002 \
    CLAUDE_DIR=/data/claude \
    MONGO_URL=mongodb://mongo:27017/usage_archive?directConnection=true

EXPOSE 3002

CMD ["node", "src/index.js"]
