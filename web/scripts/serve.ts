// Local-only static server for dist/web.

import { existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const site = join(root, "dist/web");
if (!existsSync(join(site, "index.html"))) {
  console.error("Pocket Voxel web is not built. Run: bun run web:build");
  process.exit(1);
}

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".glb": "model/gltf-binary",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const port = Number(process.env.PORT ?? 8131);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url);
    const relative = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, "") || "index.html";
    const path = resolve(site, relative);
    if (path !== site && !path.startsWith(`${site}/`)) return new Response("not found", { status: 404 });
    const file = Bun.file(path);
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    return new Response(file, {
      headers: {
        "content-type": mime[extname(path).toLowerCase()] ?? "application/octet-stream",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  },
});

console.log(`Pocket Voxel web: http://127.0.0.1:${server.port}/`);
