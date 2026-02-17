FROM debian:bookworm-slim

ARG S6_OVERLAY_VERSION=3.2.0.2
ARG TTYD_VERSION=1.7.7
ARG TARGETARCH

# Install base packages
RUN apt-get update && apt-get install -y --no-install-recommends \
        openssh-server \
        git \
        curl \
        ca-certificates \
        sudo \
        xz-utils \
        bash \
        jq \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20 (LTS) for MCP servers
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Docker Engine (requires Sysbox runtime on host for DinD)
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
       https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod a+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] \
       https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Install s6-overlay v3
ADD https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz /tmp/
ADD https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-x86_64.tar.xz /tmp/
RUN tar -C / -Jxpf /tmp/s6-overlay-noarch.tar.xz \
    && tar -C / -Jxpf /tmp/s6-overlay-x86_64.tar.xz \
    && rm /tmp/s6-overlay-*.tar.xz

# Install ttyd
ADD https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.x86_64 /usr/local/bin/ttyd
RUN chmod +x /usr/local/bin/ttyd

# Create non-root user
RUN useradd -m -s /bin/bash -u 1000 claude \
    && echo "claude ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/claude \
    && chmod 0440 /etc/sudoers.d/claude \
    && usermod -aG docker claude

# Create volume mount points
RUN mkdir -p /home/claude/.claude /home/claude/workspace /home/claude/.npm-global /home/claude/.config /home/claude/.gnupg \
    && chown -R claude:claude /home/claude \
    && chmod 700 /home/claude/.gnupg

# Redirect npm global prefix to a persistent volume
RUN npm config -g set prefix /home/claude/.npm-global
ENV PATH="/home/claude/.npm-global/bin:${PATH}"

# Install Claude Code via native installer as claude user
USER claude
RUN curl -fsSL https://claude.ai/install.sh | bash
USER root
RUN ln -sf /home/claude/.local/bin/claude /usr/local/bin/claude

# Copy s6 service definitions and configs
COPY rootfs/ /

# Make scripts executable
RUN chmod +x /etc/s6-overlay/scripts/init.sh \
    && chmod +x /etc/s6-overlay/s6-rc.d/sshd/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/ttyd/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/dockerd/run

# Set environment for Claude
ENV S6_KEEP_ENV=1
ENV S6_BEHAVIOUR_IF_STAGE2_FAILS=2
ENV CLAUDE_CONFIG_DIR=/home/claude/.claude

EXPOSE 2222 7681

ENTRYPOINT ["/init"]
