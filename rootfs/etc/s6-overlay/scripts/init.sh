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

# Ensure key directories exist on the volume
mkdir -p /home/claude/.claude/ssh
mkdir -p /home/claude/workspace
mkdir -p /home/claude/.gnupg
touch /home/claude/.claude/ssh/authorized_keys
chmod 700 /home/claude/.claude/ssh
chmod 600 /home/claude/.claude/ssh/authorized_keys
chmod 700 /home/claude/.gnupg

# Ensure Docker runtime directories exist
mkdir -p /var/run/docker

# Clone dotfiles repo on first boot (optional, set DOTFILES_REPO to enable)
if [ -n "$DOTFILES_REPO" ] && [ ! -d /home/claude/dotfiles ]; then
    DOTFILES_BRANCH_FLAG=""
    if [ -n "$DOTFILES_BRANCH" ]; then
        DOTFILES_BRANCH_FLAG="--branch $DOTFILES_BRANCH"
    fi

    if su - claude -c "git clone $DOTFILES_BRANCH_FLAG '$DOTFILES_REPO' /home/claude/dotfiles" 2>/dev/null; then
        # Run install script if one exists
        for script in install.sh setup.sh bootstrap.sh; do
            if [ -x "/home/claude/dotfiles/$script" ]; then
                su - claude -c "cd /home/claude/dotfiles && ./$script"
                break
            fi
        done

        # If Makefile exists and no install script was found, run make
        if [ ! -x "/home/claude/dotfiles/install.sh" ] && \
           [ ! -x "/home/claude/dotfiles/setup.sh" ] && \
           [ ! -x "/home/claude/dotfiles/bootstrap.sh" ] && \
           [ -f "/home/claude/dotfiles/Makefile" ]; then
            su - claude -c "cd /home/claude/dotfiles && make"
        fi
    fi
fi

# Fix ownership on mounted volume
chown -R claude:claude /home/claude
