# Claude Bridge for Figma

A Figma plugin + local MCP server that let any `claude` CLI session read and
edit the file you have open in Figma — no API key needed, since the CLI
session you're already signed into does the talking.

```
 claude (terminal)  <-- MCP (stdio) -->  server/index.js  <-- WebSocket -->  Figma plugin (src/ui.html)  <-- postMessage -->  src/code.ts (Plugin API)
```

## Setup

1. Install dependencies and build the plugin bundle:

   ```bash
   npm install
   npm run build
   ```

2. In the Figma desktop app: **Plugins → Development → Import plugin from
   manifest…** and select `manifest.json` in this folder.

3. Register the bridge server with Claude Code (run once per machine):

   ```bash
   claude mcp add figma-bridge -- node "/absolute/path/to/figma-claude-chat-plugin/server/index.js"
   ```

   Any local `claude` CLI session started after this will have the
   `figma_*` tools available.

4. Open a file in Figma, then run the **Claude Bridge** plugin
   (Plugins → Development → Claude Bridge). Its panel shows "Connected"
   once it reaches the server and starts the WebSocket listener on
   `localhost:8722`.

5. In your terminal, ask Claude to inspect or edit the file — e.g. "what's
   selected in Figma right now?" or "rename the selected layer to Header".
   Claude calls the `figma_*` tools, which relay to the open plugin and
   apply the change live.

## Available tools

- `figma_get_status` — file name, page name, editor type, selection count
- `figma_get_selection` — id/name/type of each selected node
- `figma_get_page_nodes` — top-level nodes on the current page
- `figma_rename_node` — rename a node by id
- `figma_set_fill_color` — set a node's solid fill (RGBA, 0–1 floats)
- `figma_create_rectangle` — create a rectangle at a position/size

Add more by pairing a `case` in `src/code.ts`'s `handle()` with a
`server.registerTool(...)` call in `server/index.js` — they share the same
`{ id, type, ...payload }` command shape over the WebSocket.

## Notes

- Only one Figma file/plugin instance is expected to be connected to the
  bridge at a time (last connection wins).
- The plugin's `networkAccess.allowedDomains` in `manifest.json` is pinned to
  `localhost:8722`; change `FIGMA_BRIDGE_PORT` and the manifest together if
  you need a different port.
- `src/code.ts` runs in Figma's plugin sandbox, which has no `eval`/`Function`
  constructor — that's why edits are exposed as discrete typed commands
  rather than arbitrary code execution.
