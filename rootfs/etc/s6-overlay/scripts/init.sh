#!/bin/bash
set -e

# Generate SSH host keys if missing
if [ ! -f /etc/ssh/ssh_host_rsa_key ]; then
    ssh-keygen -A
fi

# Backward compat: honor old env var name with deprecation warning
if [ -z "$SSH_PASSWORD" ] && [ -n "$CLAUDE_USER_PASSWORD" ]; then
    echo "init: WARNING: CLAUDE_USER_PASSWORD is deprecated, use SSH_PASSWORD instead" >&2
    SSH_PASSWORD="$CLAUDE_USER_PASSWORD"
fi

# Set hatchpod user password from env
if [ -n "$SSH_PASSWORD" ]; then
    echo "hatchpod:${SSH_PASSWORD}" | chpasswd
fi

# Ensure SSH run directory exists
mkdir -p /run/sshd

# Ensure key directories exist on the volume
mkdir -p /home/hatchpod/.claude/ssh
mkdir -p /home/hatchpod/workspace
mkdir -p /home/hatchpod/.gnupg
touch /home/hatchpod/.claude/ssh/authorized_keys
chmod 700 /home/hatchpod/.claude/ssh
chmod 600 /home/hatchpod/.claude/ssh/authorized_keys
chmod 700 /home/hatchpod/.gnupg

# Ensure Docker runtime directories exist
mkdir -p /var/run/docker

# Clone dotfiles repo on first boot (optional, set DOTFILES_REPO to enable)
if [ -n "$DOTFILES_REPO" ] && [ ! -d /home/hatchpod/dotfiles ]; then
    clone_args="git clone"
    if [ -n "$DOTFILES_BRANCH" ]; then
        clone_args="$clone_args --branch $(printf '%q' "$DOTFILES_BRANCH")"
    fi
    clone_args="$clone_args $(printf '%q' "$DOTFILES_REPO") /home/hatchpod/dotfiles"

    if su - hatchpod -c "$clone_args"; then
        # Run install script if one exists
        install_ran=false
        for script in install.sh setup.sh bootstrap.sh; do
            if [ -x "/home/hatchpod/dotfiles/$script" ]; then
                su - hatchpod -c "cd /home/hatchpod/dotfiles && ./$script"
                install_ran=true
                break
            fi
        done

        # If Makefile exists and no install script was found, run make
        if [ "$install_ran" = false ] && [ -f "/home/hatchpod/dotfiles/Makefile" ]; then
            su - hatchpod -c "cd /home/hatchpod/dotfiles && make"
        fi
    else
        echo "init: warning: dotfiles clone failed for $DOTFILES_REPO" >&2
    fi
fi

# Seed default dotfiles on fresh volumes (don't overwrite user customizations)
for f in .bashrc .profile .tmux.conf; do
    if [ ! -f "/home/hatchpod/$f" ] && [ -f "/etc/skel/$f" ]; then
        cp "/etc/skel/$f" "/home/hatchpod/$f"
    fi
done

# Fix ownership on mounted volume
chown -R hatchpod:hatchpod /home/hatchpod
