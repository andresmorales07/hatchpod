# Claude Box - Project Guide

## Overview

Claude Box is a Dockerized Claude Code environment with multi-machine access via SSH (port 2222) and a web terminal (port 7681, ttyd). It uses s6-overlay for process supervision.

## Project Structure

```
├── Dockerfile              # Debian bookworm-slim, Node.js 20, s6-overlay, ttyd, Claude Code
├── docker-compose.yml      # Service definition, volumes, env vars
├── Makefile                # build, up, down, logs, shell, ssh, clean
├── .env.example            # Template for CLAUDE_CODE_OAUTH_TOKEN and passwords
└── rootfs/                 # Files copied into the container at /
    └── etc/
        ├── ssh/sshd_config
        └── s6-overlay/
            ├── scripts/init.sh          # Oneshot: SSH keys, user password, volume ownership
            └── s6-rc.d/
                ├── init/                # Oneshot service (runs init.sh)
                ├── sshd/                # Long-running SSH daemon
                ├── ttyd/                # Long-running web terminal
                └── user/                # Bundle: init + sshd + ttyd
```

## Authentication

Uses `CLAUDE_CODE_OAUTH_TOKEN` (OAuth token from `claude setup-token`) — not `ANTHROPIC_API_KEY`. If `ANTHROPIC_API_KEY` is set, Claude Code will use API billing instead of the Max/Pro subscription, so never set both.

## Key Conventions

- Container runs as `claude` user (uid 1000) with passwordless sudo
- Two Docker volumes: `claude-config` (~/.claude) and `workspace` (~/workspace)
- s6-overlay v3 service types: `oneshot` for init, `longrun` for sshd/ttyd, `bundle` for user
- `S6_KEEP_ENV=1` ensures environment variables propagate to all services
- sshd `AcceptEnv` allows `CLAUDE_CODE_OAUTH_TOKEN` to pass through SSH sessions

## Building and Testing

```bash
make build    # Build the Docker image
make up       # Start the container
make down     # Stop the container
make clean    # Stop, remove volumes and image
```
