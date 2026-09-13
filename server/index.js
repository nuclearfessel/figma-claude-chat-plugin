#!/usr/bin/env node
// MCP server that bridges Claude (any local `claude` CLI session with this
// server registered) to a running Figma plugin. Speaks MCP over stdio to
// Claude, and WebSocket to the plugin's UI (src/ui.html).
//
// Usage:
//   node server/index.js
//   claude mcp add figma-bridge -- node /absolute/path/to/server/index.js

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const PORT = Number(process.env.FIGMA_BRIDGE_PORT || 8722);
const COMMAND_TIMEOUT_MS = 15000;

let pluginSocket = null;
const pending = new Map(); // id -> { resolve, reject, timer }

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (socket) => {
  // Only one Figma file is expected to be open against this bridge at a time.
  pluginSocket = socket;

  socket.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
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

function sendCommand(type, payload = {}) {
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

const transport = new StdioServerTransport();
await server.connect(transport);

console.error(`[figma-bridge] MCP server ready. WebSocket listening on ws://localhost:${PORT}`);
