#!/bin/bash
set -e

# Generate SSH host keys if missing
if [ ! -f /etc/ssh/ssh_host_rsa_key ]; then
    ssh-keygen -A
fi

# Set claude user password from env
if [ -n "$CLAUDE_USER_PASSWORD" ]; then
    echo "claude:${CLAUDE_USER_PASSWORD}" | chpasswd
fi

# Ensure SSH run directory exists
mkdir -p /run/sshd

# Fix ownership on mounted volumes
chown -R claude:claude /home/claude/.claude
chown -R claude:claude /home/claude/workspace
