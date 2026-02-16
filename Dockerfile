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
    && chmod 0440 /etc/sudoers.d/claude

# Install Claude Code via npm (official method)
RUN npm install -g @anthropic-ai/claude-code

# Create volume mount points
RUN mkdir -p /home/claude/.claude /home/claude/workspace \
    && chown -R claude:claude /home/claude

# Copy s6 service definitions and configs
COPY rootfs/ /

# Make scripts executable
RUN chmod +x /etc/s6-overlay/scripts/init.sh \
    && chmod +x /etc/s6-overlay/s6-rc.d/sshd/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/ttyd/run

# Set environment for Claude
ENV S6_KEEP_ENV=1
ENV S6_BEHAVIOUR_IF_STAGE2_FAILS=2

EXPOSE 2222 7681

ENTRYPOINT ["/init"]
