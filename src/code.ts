// Main thread (sandbox). Has access to the Figma document but no network access —
// that's why src/ui.html holds the WebSocket connection to the local bridge server
// and forwards commands here over postMessage.

figma.showUI(__html__, { width: 420, height: 560, themeColors: true });

type Command =
  | { id: string; type: "resize"; width: number; height: number }
  | { id: string; type: "get-status" }
  | { id: string; type: "get-selection" }
  | { id: string; type: "get-page-nodes" }
  | { id: string; type: "rename-node"; nodeId: string; name: string }
  | {
      id: string;
      type: "set-fill-color";
      nodeId: string;
      r: number;
      g: number;
      b: number;
      a?: number;
    }
  | {
      id: string;
      type: "create-rectangle";
      x: number;
      y: number;
      width: number;
      height: number;
      name?: string;
    };

function nodeSummary(node: BaseNode) {
  return { id: node.id, name: node.name, type: node.type };
}

function findNodeOrThrow(nodeId: string): BaseNode {
  const node = figma.getNodeById(nodeId);
  if (!node) throw new Error(`No node with id "${nodeId}" on this page.`);
  return node;
}

async function handle(cmd: Command): Promise<unknown> {
  switch (cmd.type) {
    case "resize":
      figma.ui.resize(
        Math.max(320, Math.round(cmd.width)),
        Math.max(360, Math.round(cmd.height))
      );
      return { ok: true };

    case "get-status":
      return {
        fileName: figma.root.name,
        pageName: figma.currentPage.name,
        selectionCount: figma.currentPage.selection.length,
        editorType: figma.editorType,
      };

    case "get-selection":
      return figma.currentPage.selection.map(nodeSummary);

    case "get-page-nodes":
      return figma.currentPage.children.map(nodeSummary);

    case "rename-node": {
      const node = findNodeOrThrow(cmd.nodeId);
      node.name = cmd.name;
      return nodeSummary(node);
    }

    case "set-fill-color": {
      const node = findNodeOrThrow(cmd.nodeId);
      if (!("fills" in node)) {
        throw new Error(`Node "${node.name}" (${node.type}) doesn't support fills.`);
      }
      const paint: SolidPaint = {
        type: "SOLID",
        color: { r: cmd.r, g: cmd.g, b: cmd.b },
        opacity: cmd.a ?? 1,
      };
      (node as GeometryMixin).fills = [paint];
      return nodeSummary(node);
    }

    case "create-rectangle": {
      const rect = figma.createRectangle();
      rect.x = cmd.x;
      rect.y = cmd.y;
      rect.resize(cmd.width, cmd.height);
      if (cmd.name) rect.name = cmd.name;
      figma.currentPage.appendChild(rect);
      return nodeSummary(rect);
    }

    default:
      throw new Error(`Unknown command type: ${(cmd as { type: string }).type}`);
  }
}

figma.ui.onmessage = async (cmd: Command) => {
  try {
    const result = await handle(cmd);
    figma.ui.postMessage({ id: cmd.id, type: "result", result });
  } catch (err) {
    figma.ui.postMessage({
      id: cmd.id,
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
