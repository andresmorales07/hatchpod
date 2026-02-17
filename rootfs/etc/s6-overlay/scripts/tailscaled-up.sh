#!/bin/bash

# Skip if Tailscale is not configured
if [ -z "$TS_AUTHKEY" ]; then
    exit 0
fi

# Wait for tailscaled socket to be ready
for i in $(seq 1 30); do
    if [ -S /var/run/tailscale/tailscaled.sock ]; then
        break
    fi
    sleep 0.5
done

if [ ! -S /var/run/tailscale/tailscaled.sock ]; then
    echo "tailscaled-up: timed out waiting for tailscaled socket" >&2
    exit 1
fi

exec tailscale up \
    --authkey="$TS_AUTHKEY" \
    --hostname="${TS_HOSTNAME:-claude-box}" \
    --ssh=false \
    --accept-dns=false
