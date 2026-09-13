#!/usr/bin/env node
// Bridges Claude to a running Figma plugin, two ways at once:
//
//  1. MCP tools (stdio) so any `claude` CLI session can read/edit the open
//     Figma file — figma_get_status, figma_rename_node, etc.
//  2. A persistent embedded `claude -p` chat session that the Figma plugin's
//     own panel talks to directly, so you can prompt Claude from inside
//     Figma. That embedded session gets the same figma_* tools.
//
// Every `claude mcp add figma-bridge ...` session spawns its own copy of
// this file over stdio. Only one of them can own the WebSocket server that
// talks to the Figma plugin (localhost:8722), so the first copy to bind the
// port becomes the "hub" and later copies become thin HTTP "proxies" that
// relay through it — instead of crashing with EADDRINUSE like before.
//
// Usage:
//   node server/index.js
//   claude mcp add figma-bridge -- node /absolute/path/to/server/index.js

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

const PORT = Number(process.env.FIGMA_BRIDGE_PORT || 8722);
const COMMAND_TIMEOUT_MS = 15000;
const THIS_FILE = fileURLToPath(import.meta.url);

let pluginSocket = null;
const pending = new Map(); // id -> { resolve, reject, timer }
let isHub = false;

// ---------------------------------------------------------------------------
// Hub election: try to bind the port. Winner owns the WebSocket to the Figma
// plugin and a tiny HTTP relay; losers proxy figma_* calls through that HTTP
// relay instead of talking to the plugin directly.
// ---------------------------------------------------------------------------

const httpServer = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/command") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { type, ...payload } = JSON.parse(body || "{}");
        const result = await hubSendCommand(type, payload);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ result }));
      } catch (err) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer });

// `ws` re-emits the underlying http.Server's "error" event on the
// WebSocketServer itself; electHub() below is the one that actually reacts
// to EADDRINUSE (via httpServer's own "error" listener), so this just
// prevents Node's default "throw on unhandled error event" behavior.
wss.on("error", () => {});

wss.on("connection", (socket) => {
  // Only one Figma file is expected to be open against this bridge at a time.
  pluginSocket = socket;
  chatBroadcast({ type: "chat:bridge-connected" });

  socket.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "chat:send" && typeof msg.text === "string") {
      sendChatMessage(msg.text);
      return;
    }

    const entry = pending.get(msg.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(msg.id);
    if (msg.type === "error") {
      entry.reject(new Error(msg.message));
    } else {
      entry.resolve(msg.result);
    }
  });

  socket.on("close", () => {
    if (pluginSocket === socket) pluginSocket = null;
  });
});

function hubSendCommand(type, payload = {}) {
  if (!pluginSocket || pluginSocket.readyState !== pluginSocket.OPEN) {
    return Promise.reject(
      new Error(
        "No Figma plugin is connected. Open the Claude Bridge plugin in Figma first."
      )
    );
  }
  const id = randomUUID();
  const command = { id, type, ...payload };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for Figma to respond to "${type}".`));
    }, COMMAND_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    pluginSocket.send(JSON.stringify(command));
  });
}

async function proxySendCommand(type, payload = {}) {
  const res = await fetch(`http://localhost:${PORT}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type, ...payload }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Bridge hub request failed (${res.status})`);
  return data.result;
}

async function sendCommand(type, payload) {
  return isHub ? hubSendCommand(type, payload) : proxySendCommand(type, payload);
}

async function electHub() {
  isHub = await new Promise((resolve) => {
    httpServer.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        resolve(false);
      } else {
        throw err;
      }
    });
    httpServer.listen(PORT, () => resolve(true));
  });
}

// ---------------------------------------------------------------------------
// Embedded chat session (hub only): a persistent `claude -p` child process
// that the Figma panel's UI talks to, with figma_* tools available to it via
// this same server acting as its MCP config.
// ---------------------------------------------------------------------------

let chatChild = null;

function chatBroadcast(payload) {
  if (pluginSocket && pluginSocket.readyState === pluginSocket.OPEN) {
    pluginSocket.send(JSON.stringify(payload));
  }
}

function embeddedMcpConfigPath() {
  const configPath = path.join(tmpdir(), "figma-bridge-mcp-config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        "figma-bridge": { command: "node", args: [THIS_FILE] },
        "figma-console": { command: "npx", args: ["-y", "figma-console-mcp@latest"] },
      },
    })
  );
  return configPath;
}

function ensureChatChild() {
  if (chatChild && chatChild.exitCode === null) return chatChild;

  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--permission-prompts", "none",
    "--tools", "",
    "--mcp-config", embeddedMcpConfigPath(),
    "--strict-mcp-config",
    "--allowedTools", "mcp__figma-bridge__*,mcp__figma-console__*",
    "--verbose",
  ];

  const child = spawn("claude", args);
  let outBuf = "";

  child.stdout.on("data", (chunk) => {
    outBuf += chunk.toString();
    let idx;
    while ((idx = outBuf.indexOf("\n")) >= 0) {
      const line = outBuf.slice(0, idx).trim();
      outBuf = outBuf.slice(idx + 1);
      if (!line) continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      handleClaudeEvent(evt);
    }
  });

  child.stderr.on("data", (chunk) => {
    chatBroadcast({ type: "chat:log", text: chunk.toString() });
  });

  child.on("exit", (code) => {
    chatBroadcast({ type: "chat:closed", code });
    if (chatChild === child) chatChild = null;
  });

  child.on("error", (err) => {
    chatBroadcast({ type: "chat:error", message: err.message });
    if (chatChild === child) chatChild = null;
  });

  chatChild = child;
  return child;
}

function handleClaudeEvent(evt) {
  if (evt.type === "system" && evt.subtype === "init") {
    chatBroadcast({ type: "chat:started" });
  } else if (
    evt.type === "stream_event" &&
    evt.event?.type === "content_block_delta" &&
    evt.event.delta?.type === "text_delta"
  ) {
    chatBroadcast({ type: "chat:delta", text: evt.event.delta.text });
  } else if (evt.type === "assistant") {
    for (const block of evt.message?.content ?? []) {
      if (block.type === "tool_use") {
        chatBroadcast({ type: "chat:tool", name: block.name, input: block.input });
      } else if (block.type === "text") {
        chatBroadcast({ type: "chat:message", text: block.text });
      }
    }
  } else if (evt.type === "result") {
    chatBroadcast({ type: "chat:done", isError: !!evt.is_error, result: evt.result });
  }
}

function sendChatMessage(text) {
  const child = ensureChatChild();
  const line =
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
    }) + "\n";
  child.stdin.write(line);
}

// ---------------------------------------------------------------------------
// MCP tools (available to any `claude` CLI session, including the embedded
// chat session above, which reaches them via the proxy path).
// ---------------------------------------------------------------------------

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

const server = new McpServer({ name: "figma-bridge", version: "0.1.0" });

server.registerTool(
  "figma_get_status",
  {
    title: "Get Figma status",
    description:
      "Get the currently open Figma file name, page name, editor type, and selection count.",
    inputSchema: {},
  },
  async () => textResult(await sendCommand("get-status"))
);

server.registerTool(
  "figma_get_selection",
  {
    title: "Get Figma selection",
    description: "List the nodes currently selected on the active page.",
    inputSchema: {},
  },
  async () => textResult(await sendCommand("get-selection"))
);

server.registerTool(
  "figma_get_page_nodes",
  {
    title: "Get top-level page nodes",
    description: "List the top-level (direct child) nodes on the current page.",
    inputSchema: {},
  },
  async () => textResult(await sendCommand("get-page-nodes"))
);

server.registerTool(
  "figma_rename_node",
  {
    title: "Rename a node",
    description: "Rename a Figma node by its id.",
    inputSchema: {
      nodeId: z.string().describe("The Figma node id, e.g. \"123:45\"."),
      name: z.string().describe("The new name for the node."),
    },
  },
  async ({ nodeId, name }) =>
    textResult(await sendCommand("rename-node", { nodeId, name }))
);

server.registerTool(
  "figma_set_fill_color",
  {
    title: "Set a node's solid fill color",
    description:
      "Replace a node's fills with a single solid color. RGB channels are 0-1 floats; alpha (opacity) is optional, default 1.",
    inputSchema: {
      nodeId: z.string(),
      r: z.number().min(0).max(1),
      g: z.number().min(0).max(1),
      b: z.number().min(0).max(1),
      a: z.number().min(0).max(1).optional(),
    },
  },
  async ({ nodeId, r, g, b, a }) =>
    textResult(await sendCommand("set-fill-color", { nodeId, r, g, b, a }))
);

server.registerTool(
  "figma_create_rectangle",
  {
    title: "Create a rectangle",
    description: "Create a rectangle on the current page at the given position and size.",
    inputSchema: {
      x: z.number(),
      y: z.number(),
      width: z.number().positive(),
      height: z.number().positive(),
      name: z.string().optional(),
    },
  },
  async ({ x, y, width, height, name }) =>
    textResult(await sendCommand("create-rectangle", { x, y, width, height, name }))
);

await electHub();

const transport = new StdioServerTransport();
await server.connect(transport);

console.error(
  isHub
    ? `[figma-bridge] Hub ready. MCP over stdio; WebSocket + relay on ws://localhost:${PORT}`
    : `[figma-bridge] Proxy ready. MCP over stdio; relaying figma_* calls to hub on localhost:${PORT}`
);
