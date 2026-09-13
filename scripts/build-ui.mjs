#!/usr/bin/env node
// Composes dist/ui.html from src/ui.template.html by inlining a base64 copy
// of the vendored figma-desktop-bridge/ui.html (see src/ui.template.html for
// why base64: avoids any HTML/JS-escaping hazard from embedding someone
// else's ~2800-line file, including a literal `</script>` sequence that
// would otherwise truncate our own <script> block).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const template = readFileSync(join(root, "src/ui.template.html"), "utf8");
const bridgeHtml = readFileSync(join(root, "figma-desktop-bridge/ui.html"), "utf8");
const bridgeB64 = Buffer.from(bridgeHtml, "utf8").toString("base64");

const placeholder = "__DESKTOP_BRIDGE_UI_B64__";
if (!template.includes(placeholder)) {
  throw new Error(`src/ui.template.html is missing the ${placeholder} placeholder`);
}

const out = template.replace(placeholder, bridgeB64);

mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(join(root, "dist/ui.html"), out);

console.log(`dist/ui.html  ${(out.length / 1024).toFixed(1)}kb`);
