# DevContainer Configuration

This devcontainer configuration is designed for GitHub Codespaces and VS Code Remote Containers.

## Key Configuration Details

### Remote User: `node` (NOT `codespace`)

**Critical:** This devcontainer uses `"remoteUser": "node"` because the Microsoft Node.js devcontainer images create a user named `node`, not `codespace`.

**Common Error:** If you see:
```
Shell server terminated (code: 126, signal:)
unable to find user codespace: no matching
```

This means the devcontainer is trying to use a user that doesn't exist in the image. The fix is to use `"remoteUser": "node"`.

## Image

Uses `mcr.microsoft.com/devcontainers/typescript-node:1-20-bookworm`:
- Node.js 20 (matches our `package.json` requirement: `node >= 20`)
- TypeScript pre-installed
- Debian bookworm base (more tools than Alpine)
- User `node` with sudo access

## Features

- **Port Forwarding:** Port 3000 for the MCP server
- **VS Code Extensions:** ESLint, Prettier, TypeScript
- **GitHub CLI:** Pre-installed for repository operations
- **Auto-setup:** Runs `npm install` after container creation

## Usage

### GitHub Codespaces
1. Create a new Codespace from the repository
2. The container will build automatically using this configuration
3. After creation, run `npm run dev` to start the TypeScript compiler in watch mode

### VS Code Local
1. Install the "Dev Containers" extension
2. Open the repository in VS Code
3. Click "Reopen in Container" when prompted
4. Wait for the container to build

## Troubleshooting

If the Codespace is in recovery mode:
1. Delete the Codespace
2. Create a new one (it will use this fixed configuration)
3. The `remoteUser: "node"` setting should resolve the exit code 126 error
