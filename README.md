# Claude Box

Dockerized Claude Code with multi-machine access. Configure once, connect from anywhere via SSH or browser.

## Quick Start

```bash
# 1. Clone and configure
git clone https://github.com/youruser/claude-box.git
cd claude-box
cp .env.example .env
# Edit .env with your OAuth token and passwords

# 2. Build and run
make build
make up

# 3. Connect
make ssh                        # SSH access
open http://localhost:7681      # Browser access
```

## Access Methods

### SSH (port 2222)

```bash
ssh -p 2222 claude@localhost
```

Use your `CLAUDE_USER_PASSWORD` to authenticate, or add your public key to the container:

```bash
ssh-copy-id -p 2222 claude@localhost
```

### Web Terminal (port 7681)

Open `http://localhost:7681` in your browser. Authenticate with `TTYD_USERNAME` / `TTYD_PASSWORD` from your `.env`.

### Direct Shell

```bash
make shell
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CLAUDE_CODE_OAUTH_TOKEN` | OAuth token from `claude setup-token` (see below) | *(required)* |
| `CLAUDE_USER_PASSWORD` | SSH password for `claude` user | `changeme` |
| `TTYD_USERNAME` | Web terminal username | `claude` |
| `TTYD_PASSWORD` | Web terminal password | `changeme` |

### Generating an OAuth Token

Claude Box authenticates using a long-lived OAuth token tied to your Claude Max or Pro subscription. To generate one:

1. On a machine with a browser, install Claude Code and run:
   ```bash
   claude setup-token
   ```
2. Follow the prompts to authenticate in your browser.
3. Copy the resulting token (starts with `sk-ant-oat01-`) into your `.env` file as `CLAUDE_CODE_OAUTH_TOKEN`.

The token is valid for one year. **Do not** set `ANTHROPIC_API_KEY` alongside this token — if both are present, Claude Code will use API billing instead of your subscription.

## MCP Server Configuration

MCP servers configured inside the container persist across restarts via the `claude-config` volume:

```bash
# SSH in and add an MCP server
ssh -p 2222 claude@localhost
claude mcp add my-server -- npx some-mcp-server
```

The configuration is stored in `~/.claude/` which is backed by a Docker volume.

## Volumes

| Volume | Container Path | Purpose |
|--------|---------------|---------|
| `claude-config` | `/home/claude/.claude` | Claude settings, MCP config |
| `workspace` | `/home/claude/workspace` | Project files |

## Make Targets

| Target | Description |
|--------|-------------|
| `make build` | Build the Docker image |
| `make up` | Start the container |
| `make down` | Stop the container |
| `make logs` | Follow container logs |
| `make shell` | Open a shell in the container |
| `make ssh` | SSH into the container |
| `make clean` | Stop container, remove volumes and image |

## Security Notes

- Change all default passwords in `.env` before exposing to a network
- The `.env` file is excluded from git via `.gitignore`
- SSH root login is disabled
- For remote access, use SSH tunneling or put behind a reverse proxy with TLS
- The `claude` user has passwordless sudo inside the container

## Backup and Restore

```bash
# Backup Claude config
docker run --rm -v claude-box_claude-config:/data -v $(pwd):/backup alpine \
    tar czf /backup/claude-config-backup.tar.gz -C /data .

# Restore
docker run --rm -v claude-box_claude-config:/data -v $(pwd):/backup alpine \
    tar xzf /backup/claude-config-backup.tar.gz -C /data
```

## Architecture

```
┌─────────────────────────────────────┐
│          claude-box container       │
│                                     │
│  ┌─────────┐    ┌───────────────┐   │
│  │  sshd   │    │  ttyd (web UI)│   │
│  │ :2222   │    │  :7681        │   │
│  └────┬────┘    └───────┬───────┘   │
│       └────────┬────────┘           │
│           Claude Code CLI           │
│           Node.js 20 (MCP)          │
│                                     │
│  Volumes:                           │
│   ~/.claude/ → claude-config vol    │
│   ~/workspace/ → workspace vol      │
└─────────────────────────────────────┘
```

Process supervision by [s6-overlay](https://github.com/just-containers/s6-overlay). Web terminal by [ttyd](https://github.com/tsl0922/ttyd).
