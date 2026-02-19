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
    # Exit 0 — Tailscale auth failure must not bring down the container.
    # S6_BEHAVIOUR_IF_STAGE2_FAILS=2 shuts down ALL services on oneshot failure.
    exit 0
fi

# Tailscale auth failure is non-fatal — log the error but always exit 0
# so that sshd, ttyd, and dockerd keep running.
if ! tailscale up \
    --authkey="$TS_AUTHKEY" \
    --hostname="${TS_HOSTNAME:-hatchpod}" \
    --ssh=false \
    --accept-dns=false; then
    echo "tailscaled-up: tailscale up failed (check TS_AUTHKEY)" >&2
fi

exit 0
