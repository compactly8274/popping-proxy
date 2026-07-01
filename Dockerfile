FROM oven/bun:1.1-debian
# Cloudflare WARP ships a closed-source daemon (warp-svc) that is
# dynamically linked against glibc, nss, dbus, etc. — it does NOT
# run on Alpine's musl libc, so we have to use the debian base.
# The .deb is fetched from Cloudflare's own apt repo at
# pkg.cloudflareclient.com; we add the GPG key, the source list,
# and apt-get install the package. iptables is a runtime dep
# pulled in by cloudflare-warp but we list it explicitly so a
# future deb change that drops it doesn't break the entrypoint.
ARG DEBIAN_FRONTEND=noninteractive
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates curl dbus gnupg iptables lsb-release; \
    # mknod is provided by coreutils, which is already in
    # debian-slim. The entrypoint uses it to create /dev/net/tun
    # if the host hasn't injected one.
    curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg \
        | gpg --dearmor \
        -o /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg; \
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com $(lsb_release -cs) main" \
        > /etc/apt/sources.list.d/cloudflare-client.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends cloudflare-warp; \
    rm -rf /var/lib/apt/lists/*
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
