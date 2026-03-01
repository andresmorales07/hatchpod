# Pin base image digest for supply-chain integrity (update periodically)
FROM debian:bookworm-slim@sha256:98f4b71de414932439ac6ac690d7060df1f27161073c5036a7553723881bffbe

ARG S6_OVERLAY_VERSION=3.2.0.2
ARG TTYD_VERSION=1.7.7
ARG RUNC_VERSION=1.1.15
ARG DOTNET_CHANNELS=""
ARG TARGETARCH

# Install base packages
RUN apt-get update && apt-get install -y --no-install-recommends \
        openssh-server \
        mosh \
        tmux \
        git \
        curl \
        ca-certificates \
        sudo \
        xz-utils \
        bash \
        jq \
        locales \
        make \
        g++ \
    && rm -rf /var/lib/apt/lists/*

# Generate en_US.UTF-8 locale (required by mosh and many CLI tools)
# Write to /etc/default/locale so PAM sets LANG in SSH sessions (needed by mosh-server)
RUN sed -i 's/# en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen \
    && locale-gen \
    && echo "LANG=en_US.UTF-8" > /etc/default/locale \
    && echo 'export LANG=en_US.UTF-8' > /etc/profile.d/locale.sh
ENV LANG=en_US.UTF-8

# Install Python 3 for MCP servers that use uvx
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20 (LTS) for MCP servers
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install uv (Python package manager, provides uvx)
COPY --from=ghcr.io/astral-sh/uv:latest@sha256:4cac394b6b72846f8a85a7a0e577c6d61d4e17fe2ccee65d9451a8b3c9efb4ac /uv /usr/local/bin/uv
COPY --from=ghcr.io/astral-sh/uv:latest@sha256:4cac394b6b72846f8a85a7a0e577c6d61d4e17fe2ccee65d9451a8b3c9efb4ac /uvx /usr/local/bin/uvx

# Install .NET SDKs (optional — set DOTNET_CHANNELS="8.0 9.0 10.0" to include, empty to skip)
# libicu72 is required at runtime by the dotnet CLI (ICU globalization support)
RUN if [ -n "${DOTNET_CHANNELS}" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends libicu72 \
      && rm -rf /var/lib/apt/lists/* \
      && curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh \
      && for channel in ${DOTNET_CHANNELS}; do \
           bash /tmp/dotnet-install.sh --channel "$channel" --install-dir /usr/share/dotnet; \
         done \
      && ln -s /usr/share/dotnet/dotnet /usr/local/bin/dotnet \
      && rm /tmp/dotnet-install.sh; \
    fi
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1

# Install Docker Engine (requires Sysbox runtime on host for DinD)
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
       https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

# Downgrade runc to 1.1.x — runc >=1.2 added a "safe procfs" check
# that uses openat2 to verify /proc is not a cross-device mount. Inside Sysbox containers,
# /proc/sys is a FUSE mount (sysboxfs), which triggers "unsafe procfs detected" and blocks
# all container launches. Staying on 1.1.x accepts known CVEs (see .trivyignore)
# in exchange for Sysbox compatibility.
RUN ARCH="$(dpkg --print-architecture)" \
    && curl -fsSL "https://github.com/opencontainers/runc/releases/download/v${RUNC_VERSION}/runc.${ARCH}" -o /tmp/runc.${ARCH} \
    && curl -fsSL "https://github.com/opencontainers/runc/releases/download/v${RUNC_VERSION}/runc.sha256sum" -o /tmp/runc.sha256sum \
    && cd /tmp && grep "runc.${ARCH}" /tmp/runc.sha256sum | sha256sum -c - \
    && mv /tmp/runc.${ARCH} /usr/bin/runc \
    && rm /tmp/runc.sha256sum \
    && chmod +x /usr/bin/runc

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod a+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] \
       https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Install Tailscale (optional VPN — activated by setting TS_AUTHKEY at runtime)
COPY --from=docker.io/tailscale/tailscale:latest@sha256:95e528798bebe75f39b10e74e7051cf51188ee615934f232ba7ad06a3390ffa1 /usr/local/bin/tailscale /usr/local/bin/tailscale
COPY --from=docker.io/tailscale/tailscale:latest@sha256:95e528798bebe75f39b10e74e7051cf51188ee615934f232ba7ad06a3390ffa1 /usr/local/bin/tailscaled /usr/local/bin/tailscaled

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
RUN useradd -m -s /bin/bash -u 1000 hatchpod \
    && echo "hatchpod ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/hatchpod \
    && chmod 0440 /etc/sudoers.d/hatchpod \
    && usermod -aG docker hatchpod

# Redirect npm global prefix to a persistent location
RUN npm config -g set prefix /home/hatchpod/.npm-global
ENV PATH="/home/hatchpod/.npm-global/bin:${PATH}"

# Install TypeScript language server for LSP support
RUN npm install -g typescript-language-server typescript

# Install Claude Code via native installer as hatchpod user
USER hatchpod
RUN curl -fsSL https://claude.ai/install.sh | bash
# Install csharp-ls language server for C# LSP support (only when dotnet is present)
RUN if [ -x /usr/local/bin/dotnet ]; then \
      dotnet tool install -g csharp-ls; \
    fi
USER root
RUN ln -sf /home/hatchpod/.local/bin/claude /usr/local/bin/claude

# Copy s6 service definitions and configs
COPY rootfs/ /

# Build web UI (Vite → static files)
COPY server/ui/package.json server/ui/package-lock.json /tmp/ui/
WORKDIR /tmp/ui
RUN npm ci
COPY server/ui/ /tmp/ui/
RUN npm run build

# Build API server (TypeScript → JS)
COPY server/package.json server/package-lock.json /opt/api-server/
WORKDIR /opt/api-server
RUN npm ci
COPY server/tsconfig.json /opt/api-server/
COPY server/src/ /opt/api-server/src/
RUN npx tsc && npm prune --production

# Copy built UI into server's public directory
# Vite outputs to ../public relative to /tmp/ui, which is /tmp/public
RUN cp -r /tmp/public /opt/api-server/public && rm -rf /tmp/ui /tmp/public

WORKDIR /

# Make scripts executable
RUN chmod +x /etc/s6-overlay/scripts/init.sh \
    && chmod +x /etc/s6-overlay/scripts/tailscaled-up.sh \
    && chmod +x /etc/s6-overlay/s6-rc.d/sshd/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/ttyd/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/dockerd/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/tailscaled/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/api/run

# Set environment for Claude
ENV S6_KEEP_ENV=1
ENV S6_BEHAVIOUR_IF_STAGE2_FAILS=2
ENV CLAUDE_CONFIG_DIR=/home/hatchpod/.claude

EXPOSE 2222 7681 8080 60000-60003/udp

ENTRYPOINT ["/init"]
