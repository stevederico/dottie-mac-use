# dottie-mac-use

macOS named tools + AX/EventKit CLI (`:1319`) + HTTP façade (`:1321`).

Completely standalone. No gateway. No Dottie.app. Own data dir.

```bash
npm install
npm start
```

| | |
|---|---|
| HTTP | `:1321` |
| AX CLI | `:1319` (`bin/dottie-mac-use-ax`) |
| Data | `~/.dottie-mac-use/` (token, workspace, permissions) |

Override data dir: `DOTTIE_MAC_USE_DATA=/path`. Desktop sets this to `~/.dottie` when embedding.

| Command | What |
|---|---|
| `npm start` | HTTP + AX |
| `npm run mcp` | MCP stdio |
| `npm run build:ax` | rebuild AX binary |

Grant **Accessibility** to `bin/dottie-mac-use-ax`.

Apple Silicon + Node ≥22.
