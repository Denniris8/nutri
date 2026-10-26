# Túnel público gratuito (Cloudflare quick tunnel) para el dashboard
FROM alpine:3.20

# cloudflared desde el release oficial (arm64)
RUN apk add --no-cache ca-certificates && \
    wget -q -O /usr/local/bin/cloudflared \
      https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 && \
    chmod +x /usr/local/bin/cloudflared

COPY notify-tunnel.sh /app/notify-tunnel.sh
RUN chmod +x /app/notify-tunnel.sh

ENTRYPOINT ["/app/notify-tunnel.sh"]
