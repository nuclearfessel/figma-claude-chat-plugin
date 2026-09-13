# Claude Bridge for Figma

[![GitHub repo](https://img.shields.io/badge/GitHub-nuclearfessel%2Ffigma--claude--chat--plugin-181717?logo=github)](https://github.com/nuclearfessel/figma-claude-chat-plugin)

A Figma plugin + local bridge server that runs Claude *inside* Figma: chat
with it directly from the plugin panel, and any `claude` CLI session in your
terminal can also read and edit the open file — no API key needed, since the
CLI session you're already signed into does the talking either way.

```
                                          +-- MCP (stdio) --  claude (terminal, external)
                                          |
 Figma plugin panel (dist/ui.html)       |
   |  ^          |  ^                    |
   |  |          |  | ws 9223-9232       |
   |  |          |  v (hidden iframe)    |
   |  |     figma-console-mcp (spawned by the embedded chat)
   |  | WebSocket (chat + figma_*)       |
   v  |                                  |
 server/index.js  <------------------ hub/proxy election on localhost:8722 --
   |
   +-- spawns an embedded `claude -p` chat session (stream-json), which
       reaches figma_* AND figma-console-mcp's ~140 tools
   |
   v postMessage
 dist/code.js (Plugin API + vendored Desktop Bridge logic, Figma's sandbox)
```

Every `claude mcp add figma-bridge ...` invocation, and the embedded chat
session, all spawn their own copy of `server/index.js`. Only one of them can
bind port 8722 — that one becomes the **hub**, owning the WebSocket to the
Figma plugin. The rest become **proxies** that relay `figma_*` calls to the
hub over a tiny HTTP endpoint instead of trying to bind the port themselves.

This is one plugin, not two: `figma-console-mcp`'s own "Desktop Bridge"
plugin (vendored at `figma-desktop-bridge/`, MIT-licensed, unmodified) runs
inside a hidden nested iframe within this plugin's own panel, and
`dist/code.js` is this project's sandbox code plus their vendored command
handler, merged at build time (see `scripts/build-ui.mjs` and
`src/desktop-bridge-sandbox.js`). Figma throttles background/unfocused
plugin panels, so if this were two separate plugins, whichever one didn't
have focus would stop responding — merging them avoids that entirely.

## Setup

1. Install dependencies and build the plugin bundle:

   ```bash
   npm install
   npm run build
   ```

2. In the Figma desktop app: **Plugins → Development → Import plugin from
   manifest…** and select `manifest.json` in this folder.

3. Start the bridge as a standalone, persistent process and leave it
   running (its own terminal window, a process manager, whatever keeps a
   long-lived process alive on your machine):

   ```bash
   npm run server
   ```

   This is the process that should win the hub election and hold the
   WebSocket to the Figma plugin for as long as you're using it. Don't rely
   on `claude mcp`-spawned instances for this — those are short-lived (spun
   up per session, and again for periodic health checks), and if one of them
   ends up as the hub instead, the plugin's connection drops and reconnects
   every time that process exits.

4. Register the bridge with Claude Code (run once per machine), so your
   terminal `claude` sessions get the `figma_*` tools too:

   ```bash
   claude mcp add figma-bridge -- node "/absolute/path/to/figma-claude-chat-plugin/server/index.js"
   ```

   As long as step 3's process is already running, every session this
   spawns will just proxy through it.

5. Open a file in Figma, then run the **Claude Bridge** plugin
   (Plugins → Development → Claude Bridge). Its panel shows "Connected"
   once it reaches the process from step 3 — and, invisibly in the same
   panel, `figma-console-mcp`'s vendored Desktop Bridge logic starts
   listening for its own MCP server too (ports 9223–9232), so the tools
   below work with just this one plugin open. Nothing else to import or
   run — `figma-desktop-bridge/UPSTREAM_README.md` is there only if you want
   to read about cloud pairing or other options that vendored code supports.

6. Chat with Claude right in the plugin panel — type in the box at the
   bottom. It gets its own persistent session, restricted to the tools
   listed below (no shell/file access on your machine), and can both answer
   questions and edit the file. You can *also* ask Claude to inspect or edit
   the file from your terminal — e.g. "what's selected in Figma right now?"
   or "rename the selected layer to Header" — that goes through the same
   `figma_*` tools and applies changes to the same live file.

## Available tools

### `figma_*` (this project's own tools, via `server/index.js` + `src/code.ts`)

- `figma_get_status` — file name, page name, editor type, selection count
- `figma_get_selection` — id/name/type of each selected node
- `figma_get_page_nodes` — top-level nodes on the current page
- `figma_rename_node` — rename a node by id
- `figma_set_fill_color` — set a node's solid fill (RGBA, 0–1 floats)
- `figma_create_rectangle` — create a rectangle at a position/size

Add more by pairing a `case` in `src/code.ts`'s `handle()` with a
`server.registerTool(...)` call in `server/index.js` — they share the same
`{ id, type, ...payload }` command shape over the WebSocket.

### `figma_send_message` / `figma_check_messages` (cross-session mailbox)

There's no public API for one process to push into an arbitrary
*already-running* Claude session's context — the session-to-session
messaging you may have seen elsewhere is internal to whatever harness is
hosting that session, not something a plain server can call into. So this
is a simple mailbox instead, and it works with any `claude` session that has
`figma-bridge` registered — a separate terminal, Claude Desktop, or even the
embedded panel chat itself:

- `figma_send_message({ text })` — pushes a message into the Claude Bridge
  panel's chat, rendered as a distinct "Claude Code" bubble so it's clearly
  not the embedded assistant talking.
- `figma_check_messages()` — returns the last 50 messages someone typed into
  the panel's chat box (id + text + timestamp each), so a separate session
  can pick up on them next time it checks in. Non-destructive — call it
  again later and you'll see the same messages plus any new ones.

Both live in `server/index.js` right alongside the `figma_*` tools, so they
work identically whether the calling session is the hub or a proxy. The
mailbox is in-memory only (capped at 50 entries), reset on hub restart.

### `figma_*` / `figjam_*` (from [figma-console-mcp](https://github.com/southleft/figma-console-mcp), also wired in)

The embedded chat session also gets every tool from `figma-console-mcp`
(spawned via `npx`), for full read/write coverage of the file beyond what
this project's own tools handle — this list is pulled live from the
installed package, not hand-maintained, so it stays accurate as that
package adds tools. This works out of the box once Claude Bridge is running
(step 5 above) — the Desktop Bridge logic it needs runs invisibly inside
this same plugin's panel, so most tools don't need anything extra. Two
narrower exceptions, both upstream limitations rather than anything this
project controls: a couple of tools (e.g. `figma_get_styles`) are REST-only
in the current `figma-console-mcp` release and need a `FIGMA_ACCESS_TOKEN`
regardless; and any tool needing live plugin-side execution can occasionally
need the panel to have been focused at least once since Figma opened, since
Figma throttles a plugin's background timers before its UI ever gets focus:

- **Connection / diagnostics**: `figma_get_status`, `figma_diagnose`, `figma_reconnect`, `figma_navigate`, `figma_get_console_logs`, `figma_watch_console`, `figma_clear_console`, `figma_reload_plugin`, `figma_list_open_files`, `figma_take_screenshot`
- **Reading the file**: `figma_get_file_data`, `figma_get_file_for_plugin`, `figma_get_selection`, `figma_get_design_system_kit`, `figma_get_styles`, `figma_get_text_styles`, `figma_search_components`, `figma_lint_design`
- **Nodes**: `figma_create_child`, `figma_clone_node`, `figma_delete_node`, `figma_move_node`, `figma_resize_node`, `figma_rename_node`, `figma_set_fills`, `figma_set_strokes`, `figma_set_image_fill`, `figma_set_text`
- **Components**: `figma_get_component`, `figma_get_component_details`, `figma_get_component_for_development`, `figma_get_component_for_development_deep`, `figma_get_component_image`, `figma_create_component_set`, `figma_arrange_component_set`, `figma_analyze_component_set`, `figma_instantiate_component`, `figma_set_instance_properties`, `figma_add_component_property`, `figma_edit_component_property`, `figma_delete_component_property`, `figma_create_slot`, `figma_get_slots`, `figma_append_to_slot`, `figma_reset_slot`, `figma_add_slot_property`, `figma_set_description`
- **Libraries**: `figma_get_library_component_by_key`, `figma_get_library_components`, `figma_get_library_variables`, `figma_import_library_variable`
- **Variables / design tokens**: `figma_get_variables`, `figma_get_token_values`, `figma_create_variable`, `figma_create_variable_collection`, `figma_update_variable`, `figma_rename_variable`, `figma_delete_variable`, `figma_delete_variable_collection`, `figma_add_mode`, `figma_rename_mode`, `figma_batch_create_variables`, `figma_batch_update_variables`, `figma_setup_design_tokens`, `figma_export_tokens`, `figma_import_tokens`
- **Design-system extraction (from a codebase)**: `figma_ds_analyze`, `figma_ds_extract_tokens`, `figma_ds_extract_component`, `figma_ds_scaffold`, `figma_ds_setup_storybook`, `figma_ds_verify`, `figma_ds_status`
- **Auditing / code parity**: `figma_audit_design_system_report`, `figma_audit_component_accessibility`, `figma_scan_code_accessibility`, `figma_check_design_parity`, `figma_generate_component_doc`, `figma_generate_changelog`
- **Comments & annotations**: `figma_get_comments`, `figma_post_comment`, `figma_delete_comment`, `figma_get_annotations`, `figma_set_annotations`, `figma_get_annotation_categories`
- **Version history**: `figma_get_file_versions`, `figma_get_file_at_version`, `figma_diff_versions`, `figma_get_changes_since_version`, `figma_get_design_changes`, `figma_blame_node`
- **Slides**: `figma_list_slides`, `figma_get_slide_content`, `figma_get_slide_grid`, `figma_get_slide_transition`, `figma_get_focused_slide`, `figma_focus_slide`, `figma_create_slide`, `figma_delete_slide`, `figma_duplicate_slide`, `figma_reorder_slides`, `figma_skip_slide`, `figma_set_slide_transition`, `figma_set_slide_background`, `figma_set_slides_view_mode`, `figma_add_text_to_slide`, `figma_add_shape_to_slide`
- **FigJam**: `figjam_create_sticky`, `figjam_create_stickies`, `figjam_create_connector`, `figjam_create_shape_with_text`, `figjam_create_table`, `figjam_create_code_block`, `figjam_auto_arrange`, `figjam_get_board_contents`, `figjam_get_connections`
- **Power tool**: `figma_execute` — runs arbitrary Figma Plugin API code, for anything not covered by a dedicated tool above; `figma_execute_across_files` runs the same script across every connected file at once

This is enabled in `ensureChatChild()` in `server/index.js`: the embedded
session's `--mcp-config` registers both `figma-bridge` (this project) and
`figma-console` (`npx -y figma-console-mcp@latest`) with
`--strict-mcp-config`, and `--allowedTools` includes both
`mcp__figma-bridge__*` and `mcp__figma-console__*`.

## Notes

- Only one Figma file/plugin instance is expected to be connected to the
  bridge at a time (last connection wins).
- The plugin's `networkAccess.allowedDomains` in `manifest.json` is pinned to
  `localhost:8722`; change `FIGMA_BRIDGE_PORT` and the manifest together if
  you need a different port.
- `src/code.ts` runs in Figma's plugin sandbox, which has no `eval`/`Function`
  constructor — that's why edits are exposed as discrete typed commands
  rather than arbitrary code execution.
- The embedded chat session is spawned with `--tools ""` and
  `--allowedTools "mcp__figma-bridge__*"` plus `--strict-mcp-config`, so it
  only ever sees the `figma_*` tools — not your shell, filesystem, or any
  other MCP servers configured on your machine.
- The chat session is persistent per hub process: closing and reopening the
  plugin panel doesn't restart it, but killing the hub process does. It
  restarts lazily on your next message.
