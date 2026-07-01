FROM oven/bun:1.1-alpine
# cloudflare-warp is in Alpine 3.21 community repo. The package
# pulls warp-svc + warp-cli. iptables is a runtime dep for the
# tunnel setup; some alpine builds don't auto-pull it. We install
# it explicitly so the first boot doesn't fail with a missing
# iptables-restore.
RUN apk add --no-cache cloudflare-warp iptables
WORKDIR /app
COPY package.json ./
COPY server.ts ./
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
# 3001 by default — one above the user's Hydra service on 3000.
# Override at run time with `-e PORT=...` or in docker-compose.yml.
EXPOSE 3001
# entrypoint.sh runs as root (warp-svc needs CAP_NET_ADMIN to
# create the tun device), brings up the WARP SOCKS5 proxy on
# 127.0.0.1:40000, then drops privs to the unprivileged `bun` user
# and execs the server. The container needs `cap_add: [NET_ADMIN]`
# in compose for the tun device to work; without it the entrypoint
# fails fast on the socks5 wait and the container restarts.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bun", "run", "server.ts"]
