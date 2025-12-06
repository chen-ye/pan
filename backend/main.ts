
import { join, extname, relative, dirname } from "@std/path";
import { walk, ensureDir } from "@std/fs";
import { Application, Router, send, Context, ServerSentEventTarget, ServerSentEvent } from "jsr:@oak/oak";

console.log("Backend starting...");

const DATA_DIR = Deno.env.get("DATA_DIR") || "./data";
const WORKER_URL = Deno.env.get("WORKER_URL") || "http://worker:5000";
const METADATA_FILE = join(DATA_DIR, "metadata.json");

// Cache for video metadata (duration, etc.)
const metadataCache = new Map<string, any>();
let cacheDirty = false;

// Load cache
console.log("Loading metadata cache...");
try {
  const data = Deno.readTextFileSync(METADATA_FILE);
  const json = JSON.parse(data);
  for (const key in json) {
    metadataCache.set(key, json[key]);
  }
  console.log("Metadata loaded.");
} catch (e) {
  console.log("Metadata load skipped/failed:", e);
}
console.log("Metadata block finished.");

console.log("Setting up save interval...");

// Debounced save
setInterval(async () => {
    if (cacheDirty) {
        cacheDirty = false;
        try {
            await Deno.writeTextFile(METADATA_FILE, JSON.stringify(Object.fromEntries(metadataCache)));
        } catch (e) {
            console.error("Failed to save metadata cache", e);
        }
    }
}, 5000);
console.log("Save interval set.");

interface VideoEntry {
    path: string;
    name: string;
    fullPath: string;
}

// In-memory video library
let videoLibrary: VideoEntry[] = [];

function isVideo(filename: string) {
    const ext = extname(filename).toLowerCase();
    return [".mp4", ".mov", ".avi", ".mkv", ".webm"].includes(ext);
}

async function refreshLibrary() {
    console.log("Refreshing video library...");
    const tempLib: VideoEntry[] = [];
    try {
        for await (const entry of walk(DATA_DIR)) {
            if (entry.isFile && isVideo(entry.name)) {
                const relPath = relative(DATA_DIR, entry.path);
                tempLib.push({
                    path: relPath,
                    name: entry.name,
                    fullPath: entry.path
                });
            }
        }
        tempLib.sort((a, b) => a.name.localeCompare(b.name));
        videoLibrary = tempLib;
        console.log(`Library refreshed. ${videoLibrary.length} videos found.`);
        notifyClients();
    } catch (e) {
        console.error("Error refreshing library", e);
    }
}

// Initial hydration - delayed to allow server startup
setTimeout(() => {
    refreshLibrary();
}, 100);

// Watch for changes disabled for now because watchFs does not work well on large directories
let refreshTimer: number | undefined;
// setTimeout(() => {
//     console.log("Initializing watcher...");
//     (async () => {
//         try {
//             const watcher = Deno.watchFs(DATA_DIR, { recursive: true });
//             console.log("Watcher initialized.");
//             for await (const event of watcher) {
//                 // Ignore dotfiles
//                 if (event.paths.some(p => p.includes("/."))) continue;

//                 // Debounce refresh
//                 if (refreshTimer) clearTimeout(refreshTimer);
//                 refreshTimer = setTimeout(() => {
//                     refreshLibrary();
//                 }, 2000);
//             }
//         } catch(e) { console.error("Watcher error", e); }
//     })();
// }, 2000);

// SSE Clients
const clients = new Set<ServerSentEventTarget>();

function notifyClients() {
    for (const client of clients) {
        client.dispatchEvent(new ServerSentEvent("update", { data: JSON.stringify({ timestamp: Date.now() }) }));
    }
}
//         } catch (e) {
//            console.error("Watcher failed", e);
//         }
//     })();
// }, 10000); // 10 seconds delay


// -- OAK SERVER SETUP --

const app = new Application();
const router = new Router();

// Middleware: CORS & Error Handling
app.use(async (ctx, next) => {
  ctx.response.headers.set("Access-Control-Allow-Origin", "*");
  ctx.response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  ctx.response.headers.set("Access-Control-Allow-Headers", "Content-Type, Range");
  ctx.response.headers.set("Access-Control-Expose-Headers", "Content-Length, Content-Range");

  if (ctx.request.method === "OPTIONS") {
    ctx.response.status = 204;
    return;
  }

  try {
    await next();
  } catch (err: any) {
    console.error("Server error:", err);
    ctx.response.status = 500;
    ctx.response.body = { error: err.message };
  }
});

// Helper: Directory Tree
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

// Helper: Duration
async function getVideoDuration(path: string): Promise<number | undefined> {
    const relPath = relative(DATA_DIR, path);
    if (metadataCache.has(relPath)) {
        return metadataCache.get(relPath).duration;
    }

    const cmd = new Deno.Command("ffprobe", {
        args: [
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            path
        ],
        stdout: "piped",
        stderr: "piped"
    });

    const output = await cmd.output();
    if (output.code === 0) {
        const durationStr = new TextDecoder().decode(output.stdout).trim();
        const duration = parseFloat(durationStr);
        if (!isNaN(duration)) {
             metadataCache.set(relPath, { duration });
             cacheDirty = true;
             return duration;
        }
    }
    return undefined;
}

// Routes

// 1. Get Videos
router.get("/api/videos", async (ctx) => {
    const page = parseInt(ctx.request.url.searchParams.get("page") || "1");
    const limit = parseInt(ctx.request.url.searchParams.get("limit") || "50");
    const dirs = ctx.request.url.searchParams.getAll("dirs");

    console.log(`[GET /api/videos] page=${page} limit=${limit} dirs=${dirs.length}`);

    let filteredVideos = videoLibrary;

    if (dirs.length > 0) {
        filteredVideos = filteredVideos.filter(v => {
            return dirs.some(dir => v.path === dir || v.path.startsWith(dir + "/"));
        });
    }

    const total = filteredVideos.length;
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    const pageVideos = filteredVideos.slice(startIndex, endIndex);

    const mappedVideos = await Promise.all(pageVideos.map(async (v) => {
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

        return {
            path: v.path,
            name: v.name,
            processed: processed,
            size: size
        };
    }));

    ctx.response.body = {
        items: mappedVideos,
        total: total,
        page: page,
        limit: limit
    };
});

// 2. Delete Video
router.delete("/api/videos/:path*", async (ctx) => {
    const videoPath = ctx.params.path; // Named param from /:path* (wildcard captures everything)
    if (!videoPath) {
        ctx.throw(400, "Missing path");
        return;
    }

    // Safety check
    if (videoPath.includes("..")) {
        ctx.throw(400, "Invalid path");
        return;
    }

    const fullPath = join(DATA_DIR, videoPath);
    try {
        await Deno.remove(fullPath);
        // Remove json if exists
        try { await Deno.remove(fullPath + ".json"); } catch {}

        // Update in-memory cache
        videoLibrary = videoLibrary.filter(v => v.path !== videoPath);

        ctx.response.body = { success: true };
    } catch (e: any) {
        ctx.response.status = 500;
        ctx.response.body = { error: e.message };
    }
});

// 3. Move Video
router.post("/api/videos/move", async (ctx) => {
    // Body is a ReadableStream in simpler servers, but Oak parses it wrapper
    const body = await ctx.request.body.json();
    const videoPath = body.path;

    if (!videoPath) {
        ctx.throw(400, "Missing path");
        return;
    }
    if (videoPath.includes("..")) {
        ctx.throw(400, "Invalid path");
        return;
    }

    let destRelPath = "";
    if (videoPath.startsWith("NVR-blank/")) {
        destRelPath = videoPath.replace("NVR-blank/", "NVR-upload/");
    } else if (videoPath.startsWith("NVR-unprocessed/")) {
        destRelPath = videoPath.replace("NVR-unprocessed/", "NVR-upload/");
    } else {
        ctx.throw(400, "Invalid source directory");
        return;
    }

    const fullSrcPath = join(DATA_DIR, videoPath);
    const fullDestPath = join(DATA_DIR, destRelPath);

    await ensureDir(dirname(fullDestPath));
    await Deno.rename(fullSrcPath, fullDestPath);

    // Move json if exists
    try {
        await Deno.rename(fullSrcPath + ".json", fullDestPath + ".json");
    } catch {}

    // Update cache
    videoLibrary = videoLibrary.filter(v => v.path !== videoPath);

    ctx.response.body = { success: true, newPath: destRelPath };
});

// 4. Get Duration
router.get("/api/videos/duration", async (ctx) => {
    const videoPath = ctx.request.url.searchParams.get("path");
    if (!videoPath) {
        ctx.throw(400, "Missing path");
        return;
    }

    if (videoPath.includes("..")) {
         ctx.throw(400, "Invalid path");
         return;
    }

    const fullPath = join(DATA_DIR, videoPath);
    const duration = await getVideoDuration(fullPath);
    ctx.response.body = { duration };
});

// 4b. Batch Get Durations
router.post("/api/videos/durations", async (ctx) => {
    let body;
    try {
        body = await ctx.request.body.json();
    } catch {
        ctx.throw(400, "Invalid JSON");
        return;
    }

    const paths = body.paths;
    if (!Array.isArray(paths)) {
        ctx.throw(400, "Expected paths array");
        return;
    }

    const results: Record<string, number | undefined> = {};

    // Process in parallel
    await Promise.all(paths.map(async (p: string) => {
        if (!p || p.includes("..")) return;
        const fullPath = join(DATA_DIR, p);
        const duration = await getVideoDuration(fullPath);
        results[p] = duration;
    }));

    ctx.response.body = results;
});

// 5. Get Dirs
router.get("/api/dirs", async (ctx) => {
    const tree = await getDirTree(DATA_DIR);
    ctx.response.body = tree;
});

// 6. Get Results
router.get("/api/results/:path*", async (ctx) => {
    const resultPath = ctx.params.path;
    if (!resultPath || resultPath.includes("..")) {
        ctx.throw(400, "Invalid path");
        return;
    }

    const fullPath = join(DATA_DIR, resultPath + ".json");
    try {
        await send(ctx, resultPath + ".json", {
            root: DATA_DIR,
        });
    } catch {
        ctx.response.status = 404;
        ctx.response.body = { error: "Result not found" };
    }
});

// 7. Proxy Worker (Using wildcard for sub-paths)
router.all("/api/worker/(.*)", async (ctx) => {
    // Construct target URL
    // ctx.request.url.pathname -> /api/worker/process...
    // We want /process... appended to WORKER_URL
    const pathSuffix = ctx.request.url.pathname.replace("/api/worker", "");

    try {
        let body: BodyInit | null = null;
        if (ctx.request.hasBody) {
             const bodyBytes = await ctx.request.body.arrayBuffer();
             body = bodyBytes;
        }

        const workerResponse = await fetch(`${WORKER_URL}${pathSuffix}`, {
            method: ctx.request.method,
            headers: ctx.request.headers,
            body: body
        });

        const data = await workerResponse.arrayBuffer();

        ctx.response.status = workerResponse.status;
        ctx.response.body = data;

        // Copy headers
        for (const [key, value] of workerResponse.headers.entries()) {
             ctx.response.headers.set(key, value);
        }

    } catch (e: any) {
        ctx.response.status = 502;
        ctx.response.body = { error: "Worker unavailable: " + e.message };
    }
});

// 8. Serve Videos
router.get("/videos/:path*", async (ctx) => {
    const videoPath = ctx.params.path;
    console.log(`[GET /videos] requesting: ${videoPath}`);
    if (!videoPath || videoPath.includes("..")) {
        console.error(`[GET /videos] Invalid path: ${videoPath}`);
        ctx.throw(400, "Invalid path");
        return;
    }

    try {
        const fullPath = join(DATA_DIR, videoPath);
        // Best practice for video streaming: Open file stream directly
        // Oak handles Range requests automatically for FsFile bodies
        const file = await Deno.open(fullPath, { read: true });
        const fileInfo = await file.stat();

        ctx.response.body = file;
        ctx.response.type = "video/mp4"; // Ensure correct mime type
        ctx.response.headers.set("Content-Length", fileInfo.size.toString());

        console.log(`[GET /videos] serving stream: ${videoPath} (${fileInfo.size} bytes)`);
    } catch (e) {
        console.error(`[GET /videos] failed: ${e}`);
        if (e instanceof Deno.errors.NotFound) {
             ctx.response.status = 404;
             return;
        }
        ctx.response.status = 500;
    }
});

// Register routes
app.use(router.routes());
app.use(router.allowedMethods());

// 9. Serve Frontend (Fallback for everything else)
// Oak static files
app.use(async (ctx) => {
    // Serve from frontend/dist
    // If path is "/" -> index.html
    // If path is missing extension -> index.html (SPA)
    // Else -> try file

    const fsRoot = join(Deno.cwd(), "frontend/dist");
    try {
        await send(ctx, ctx.request.url.pathname, {
            root: fsRoot,
            index: "index.html",
        });
    } catch {
        // Fallback to index.html for SPA
        await send(ctx, "index.html", {
            root: fsRoot,
        });
    }
});

console.log("Starting server setup...");
console.log("Server running on http://0.0.0.0:8000");

await app.listen({ port: 8000 });
