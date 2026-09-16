# dottie-mac-use

macOS **named tools (JS)** + **AX/EventKit CLI (Swift)**. Fully standalone — no Dottie.app required.

Consumed by [dottie-desktop](https://github.com/stevederico/dottie-desktop) as a **git submodule** at `backend/gateway/dottie-mac-use`.

| Half | Where | Lang |
|---|---|---|
| Tools | `tools/` + `index.js` | JavaScript |
| AX / EventKit HTTP `:1319` | `bin/dottie-mac-use-ax` (`native/`) | Swift |
| MCP stdio | `mcp.js` | JavaScript |
| HTTP | `http.js` (optional `DOTTIE_HANDS_HTTP_PORT`) | JavaScript |

## Setup

```bash
npm install
bash native/build.sh   # → bin/dottie-mac-use-ax (arm64)
```

Binary resolve order (`ax_process.js`): `DOTTIE_MAC_USE_AX` env → `bin/dottie-mac-use-ax` → `native/.build/dottie-mac-use-ax`.

## Standalone contract

**Runtime:**
- `bin/dottie-mac-use-ax` (build: `npm run build:ax`)
- Accessibility TCC granted to **that binary** (System Settings → Privacy → Accessibility)
- `~/.dottie/agent_token` (CLI mints if missing)
- Permission scopes in `~/.dottie/agent.db` when gating tools

**Ports / env:**
- `DOTTIE_AX_PORT` (default **1319**)
- `DOTTIE_MAC_USE_AX` (binary path override)
- Optional HTTP: `DOTTIE_HANDS_HTTP_PORT`
- Vision: `DOTTIE_CHAT_PROVIDER` / `DOTTIE_CHAT_API_KEY` / `DOTTIE_CHAT_MODEL` (or inject `setChatConfigGetter`)

**Callers:**
- **Agents** — `node mcp.js` or `npm run mcp` (auto-spawns AX CLI via `ensureAxRunning`)
- **Dottie.app / gateway** — supervisor spawns the same CLI; Face only observes `:1319` health

```bash
npm run mcp
# optional HTTP:
DOTTIE_HANDS_HTTP_PORT=1321 node http.js
```

## Injectors (optional — gateway wires these)

- `setLogger({ log, getRecentErrors })`
- `setPermissionReader(fn)`
- `setChatConfigGetter(fn)`

Without injectors, package uses its own logger + SQLite permission reader + env vision defaults.

## Tests

```bash
npm test
```

Requires Node ≥22 (`node:sqlite`).
