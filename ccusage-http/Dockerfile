FROM node:22-alpine

# Pin to the ccusage v20 major line so v21 breaking changes can't slip in on
# rebuild, while still picking up v20 patches.
RUN npm install -g ccusage@20

WORKDIR /app
COPY server.js ./

ENV PORT=3001 \
    CLAUDE_CONFIG_DIR=/data/claude \
    CCUSAGE_OFFLINE=0 \
    CACHE_TTL_SECONDS=30

EXPOSE 3001
CMD ["node", "server.js"]
