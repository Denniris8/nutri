#!/bin/sh
exec cloudflared tunnel --url "${TUNNEL_TARGET:-http://127.0.0.1:8080}"
