FROM oven/bun:1.1-debian
# The WARP routing lives on the host, not in the container. The VPS runs
# cloudflare-warp in TUN mode, and a split-tunnel iptables rule routes
# only this container's egress through Cloudflare. Reddit's CDN sees
# a Cloudflare egress IP for our requests, which it doesn't blocklist.
#
# The container is therefore just a Bun app — no warp-svc, no dbus,
# no TUN, no caps, no sysctls. WARP_ACCEPT_TOS-style env vars don't
# exist anymore; the operator configures WARP on the host per the
# README's "Host setup" section.
WORKDIR /app
COPY package.json ./
COPY server.ts ./
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
# 3001 by default — one above the user's real Hydra service on 3000.
# Override at run time with `-e PORT=...` or in docker-compose.yml.
EXPOSE 3001
# Run as the unprivileged `bun` user. No entrypoint dance needed —
# WARP is on the host.
USER bun
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bun", "run", "server.ts"]
