# dottie-mac-use

macOS named tools + AX/EventKit CLI (`:1319`) + HTTP façade (`:1321`).

Standalone. No gateway. No Dottie.app.

```bash
npm install
npm start
```

AX binary ships in `bin/dottie-mac-use-ax`. Rebuild with `npm run build:ax` if missing (needs `swiftc`).

| Command | What |
|---|---|
| `npm start` | HTTP `:1321` (starts AX `:1319`) |
| `npm run mcp` | MCP stdio |

Grant **Accessibility** to `bin/dottie-mac-use-ax` (System Settings → Privacy).

State under `~/.dottie/` (token, permissions DB, workspace).

Apple Silicon + Node ≥22.
