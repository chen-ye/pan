
import { join, extname, relative } from "@std/path";
import { walk } from "@std/fs";

const DATA_DIR = Deno.env.get("DATA_DIR") || "./data";
const WORKER_URL = Deno.env.get("WORKER_URL") || "http://worker:5000";

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // CORS headers
  const headers = new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });

  if (req.method === "OPTIONS") {
    return new Response(null, { headers });
  }

  // API Routes
  if (path === "/api/videos" && req.method === "GET") {
    try {
      const page = parseInt(url.searchParams.get("page") || "1");
      const limit = parseInt(url.searchParams.get("limit") || "50");
      const dirs = url.searchParams.getAll("dirs");

      const allVideos = [];
      for await (const entry of walk(DATA_DIR)) {
        if (entry.isFile && isVideo(entry.name)) {
             const relPath = relative(DATA_DIR, entry.path);

             if (dirs.length > 0) {
                 const inDir = dirs.some(dir => relPath === dir || relPath.startsWith(dir + "/"));
                 if (!inDir) continue;
             }

             allVideos.push({
                 path: relPath,
                 name: entry.name,
                 fullPath: entry.path
             });
        }
      }

      // Sort
      allVideos.sort((a, b) => a.name.localeCompare(b.name));

      // Pagination
      const total = allVideos.length;
      const startIndex = (page - 1) * limit;
      const endIndex = startIndex + limit;
      const pageVideos = allVideos.slice(startIndex, endIndex);

      const mappedVideos = [];
      for (const v of pageVideos) {
           const jsonPath = v.fullPath + ".json";
           let processed = false;
           try {
               await Deno.stat(jsonPath);
               processed = true;
           } catch {}

           let size = 0;
           try {
               const info = await Deno.stat(v.fullPath);
               size = info.size;
           } catch {}

           mappedVideos.push({
               path: v.path,
               name: v.name,
               processed: processed,
               size: size
           });
      }

      return new Response(JSON.stringify({
          items: mappedVideos,
          total: total,
          page: page,
          limit: limit
      }), { headers: { ...Object.fromEntries(headers), "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
    }
  }

  if (path.startsWith("/api/videos/") && req.method === "DELETE") {
    const videoPath = path.replace("/api/videos/", "");
    // Security check: ensure no .. or traversal
    if (videoPath.includes("..")) {
        return new Response("Invalid path", { status: 400, headers });
    }
    const fullPath = join(DATA_DIR, videoPath);
    try {
        await Deno.remove(fullPath);
        // Also remove json if exists
        try { await Deno.remove(fullPath + ".json"); } catch {}
        return new Response(JSON.stringify({ success: true }), { headers: { ...Object.fromEntries(headers), "Content-Type": "application/json" } });
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
    }
    }


  // Directory Tree
  if (path === "/api/dirs" && req.method === "GET") {
      try {
          const tree = await getDirTree(DATA_DIR);
          return new Response(JSON.stringify(tree), { headers: { ...Object.fromEntries(headers), "Content-Type": "application/json" } });
      } catch (e) {
          return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
      }
  }

  // Serve Result JSON
  if (path.startsWith("/api/results/")) {
     const resultPath = path.replace("/api/results/", "");
     if (resultPath.includes("..")) return new Response("Invalid path", { status: 400 });
     // resultPath is the video path, append .json
     const fullPath = join(DATA_DIR, resultPath + ".json");
     try {
        const file = await Deno.open(fullPath, { read: true });
        return new Response(file.readable, {
            headers: {
                "Content-Type": "application/json",
                ...Object.fromEntries(headers)
            }
        });
     } catch {
         return new Response(JSON.stringify({ error: "Result not found" }), { status: 404, headers: { ...Object.fromEntries(headers), "Content-Type": "application/json" } });
     }
  }

  // Proxy to worker
  if (path.startsWith("/api/worker")) {
    const workerPath = path.replace("/api/worker", "");
    try {
        // Forward body if present
        let body = req.body;
        // If POST and body is used, we need to handle it.
        // req.body is a ReadableStream. fetch handles it.

        const workerResponse = await fetch(`${WORKER_URL}${workerPath}`, {
            method: req.method,
            headers: req.headers,
            body: body
        });

        // We need to read the response body to pass it back
        // Using arrayBuffer handles binary or text
        const data = await workerResponse.arrayBuffer();

        return new Response(data, {
            status: workerResponse.status,
            headers: {
                ...Object.fromEntries(headers),
                "Content-Type": workerResponse.headers.get("Content-Type") || "application/json"
            }
        });
    } catch (e) {
        return new Response(JSON.stringify({ error: "Worker unavailable: " + e.message }), { status: 502, headers });
    }
  }

  // Serve Video Files
  if (path.startsWith("/videos/")) {
     const videoPath = path.replace("/videos/", "");
     if (videoPath.includes("..")) return new Response("Invalid path", { status: 400 });
     const fullPath = join(DATA_DIR, videoPath);
     try {
        const file = await Deno.open(fullPath, { read: true });
        return new Response(file.readable, {
            headers: {
                "Content-Type": "video/mp4",
                ...Object.fromEntries(headers)
            }
        });
     } catch {
         return new Response("Not found", { status: 404 });
     }
  }

  // Serve Frontend Static Files
  if (path === "/" || path === "/index.html") {
    return serveFile(join(Deno.cwd(), "frontend/dist/index.html"), "text/html");
  }

  // Serve other static files
  try {
     const staticPath = join(Deno.cwd(), "frontend/dist", path);
     if (!staticPath.startsWith(join(Deno.cwd(), "frontend/dist"))) {
        return new Response("Forbidden", { status: 403 });
     }

     const fileInfo = await Deno.stat(staticPath);
     if (fileInfo.isFile) {
         const contentType = getContentType(staticPath);
         return serveFile(staticPath, contentType);
     }
  } catch {
      // Fallback
  }

  return new Response("Not Found", { status: 404 });
}

interface TreeNode {
    name: string;
    path: string;
    children: TreeNode[];
}

async function getDirTree(currentPath: string): Promise<TreeNode[]> {
    const nodes: TreeNode[] = [];
    for await (const entry of Deno.readDir(currentPath)) {
        if (entry.isDirectory) {
            const fullPath = join(currentPath, entry.name);
            const relativePath = relative(DATA_DIR, fullPath);
            nodes.push({
                name: entry.name,
                path: relativePath,
                children: await getDirTree(fullPath)
            });
        }
    }
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    return nodes;
}

function isVideo(filename: string) {
    const ext = extname(filename).toLowerCase();
    return [".mp4", ".mov", ".avi", ".mkv", ".webm"].includes(ext);
}

function getContentType(path: string) {
    const ext = extname(path).toLowerCase();
    const map: Record<string, string> = {
        ".html": "text/html",
        ".js": "application/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".svg": "image/svg+xml"
    };
    return map[ext] || "application/octet-stream";
}

async function serveFile(path: string, contentType: string) {
    try {
        const file = await Deno.open(path, { read: true });
        return new Response(file.readable, { headers: { "Content-Type": contentType } });
    } catch (e) {
        return new Response("Internal Server Error: " + e.message, { status: 500 });
    }
}

console.log("Server running on http://0.0.0.0:8000");
Deno.serve({ port: 8000, hostname: "0.0.0.0" }, handler);
