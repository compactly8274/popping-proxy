FROM oven/bun:1.1-alpine
WORKDIR /app
COPY package.json ./
COPY server.ts ./
# 3001 by default — one above the user's Hydra service on 3000.
# Override at run time with `-e PORT=...` or in docker-compose.yml.
EXPOSE 3001
USER bun
CMD ["bun", "run", "server.ts"]
