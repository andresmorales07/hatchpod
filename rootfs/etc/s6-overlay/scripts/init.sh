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
    clone_args="git clone"
    if [ -n "$DOTFILES_BRANCH" ]; then
        clone_args="$clone_args --branch $(printf '%q' "$DOTFILES_BRANCH")"
    fi
    clone_args="$clone_args $(printf '%q' "$DOTFILES_REPO") /home/claude/dotfiles"

    if su - claude -c "$clone_args"; then
        # Run install script if one exists
        install_ran=false
        for script in install.sh setup.sh bootstrap.sh; do
            if [ -x "/home/claude/dotfiles/$script" ]; then
                su - claude -c "cd /home/claude/dotfiles && ./$script"
                install_ran=true
                break
            fi
        done

        # If Makefile exists and no install script was found, run make
        if [ "$install_ran" = false ] && [ -f "/home/claude/dotfiles/Makefile" ]; then
            su - claude -c "cd /home/claude/dotfiles && make"
        fi
    else
        echo "init: warning: dotfiles clone failed for $DOTFILES_REPO" >&2
    fi
fi

# Fix ownership on mounted volume
chown -R claude:claude /home/claude
