import { Router, send } from "@oak/oak";
import { join } from "@std/path";
import { CONFIG } from "./config.ts";
import { libraryService } from "./services/library.ts";
import { metadataService } from "./services/metadata.ts";
import { sseService } from "./services/sse.ts";
import { processingService } from "./services/processing.ts";
import { getDirTree } from "./services/files.ts";

export const router = new Router();

// 1. Get Videos
router.get("/api/videos", async (ctx) => {
  const page = parseInt(ctx.request.url.searchParams.get("page") || "1");
  const limit = parseInt(ctx.request.url.searchParams.get("limit") || "50");
  const dirs = ctx.request.url.searchParams.getAll("dirs");

  let filteredVideos = libraryService.getVideos();

  if (dirs.length > 0) {
    filteredVideos = filteredVideos.filter((v) => {
      return dirs.some((dir) => v.path === dir || v.path.startsWith(dir + "/"));
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
      // Check if .json file exists (supports both legacy and new formats)
      await Deno.stat(jsonPath);
      processed = true;
    } catch { /* File doesn't exist */ }

    let size = 0;
    try {
      const info = await Deno.stat(v.fullPath);
      size = info.size;
    } catch { /* File not accessible */ }

    // We could fetch duration here but frontend does it in batch now
    return {
      path: v.path,
      name: v.name,
      processed: processed,
      size: size,
    };
  }));

  ctx.response.body = {
    items: mappedVideos,
    total: total,
    page: page,
    limit: limit,
  };
});

// 2. Delete Video
router.delete("/api/videos/:path*", async (ctx) => {
  const videoPath = ctx.params.path;
  if (!videoPath) {
    ctx.throw(400, "Missing path");
    return;
  }
  try {
    await libraryService.deleteVideo(videoPath);
    ctx.response.body = { success: true };
  } catch (e: unknown) {
    ctx.response.status = 500; // Or 400 if validation error
    ctx.response.body = { error: e instanceof Error ? e.message : String(e) };
  }
});

// 3. Move Video
router.post("/api/videos/move", async (ctx) => {
  const body = await ctx.request.body.json();
  const videoPath = body.path;
  if (!videoPath) {
    ctx.throw(400, "Missing path");
    return;
  }

  try {
    const newPath = await libraryService.moveVideo(videoPath);
    ctx.response.body = { success: true, newPath };
  } catch (e: unknown) {
    ctx.response.status = 500;
    ctx.response.body = { error: e instanceof Error ? e.message : String(e) };
  }
});

// 4. Get Duration (Single) - Kept for backward compat or specific usage
router.get("/api/videos/duration", async (ctx) => {
  const videoPath = ctx.request.url.searchParams.get("path");
  if (!videoPath || videoPath.includes("..")) {
    ctx.throw(400, "Invalid path");
    return;
  }
  const fullPath = join(CONFIG.DATA_DIR, videoPath);
  const duration = await metadataService.getDuration(fullPath);
  ctx.response.body = { duration };
});

// 4b. Batch Get Durations
router.post("/api/videos/durations", async (ctx) => {
  let body;
  try {
    body = await ctx.request.body.json();
  } catch {
    ctx.throw(400);
    return;
  }

  const paths = body.paths;
  if (!Array.isArray(paths)) {
    ctx.throw(400);
    return;
  }

  const results: Record<string, number | undefined> = {};
  await Promise.all(paths.map(async (p: string) => {
    if (!p || p.includes("..")) return;
    const fullPath = join(CONFIG.DATA_DIR, p);
    const duration = await metadataService.getDuration(fullPath);
    results[p] = duration;
  }));
  ctx.response.body = results;
});

// 5. Get Dirs
router.get("/api/dirs", async (ctx) => {
  const tree = await getDirTree(CONFIG.DATA_DIR);
  ctx.response.body = tree;
});

// 6. Get Results
router.get("/api/results/:path*", async (ctx) => {
  const resultPath = ctx.params.path;
  if (!resultPath || resultPath.includes("..")) {
    ctx.throw(400, "Invalid path");
    return;
  }
  try {
    await send(ctx, resultPath + ".json", { root: CONFIG.DATA_DIR });
  } catch {
    ctx.response.status = 404;
    ctx.response.body = { error: "Result not found" };
  }
});

// 7. Proxy Worker
router.all("/api/worker/(.*)", async (ctx) => {
  const pathSuffix = ctx.request.url.pathname.replace("/api/worker", "");
  try {
    let body: BodyInit | null = null;
    if (ctx.request.hasBody) {
      body = await ctx.request.body.arrayBuffer();
    }

    const workerResponse = await fetch(`${CONFIG.WORKER_URL}${pathSuffix}`, {
      method: ctx.request.method,
      headers: ctx.request.headers,
      body: body,
    });

    ctx.response.status = workerResponse.status;
    ctx.response.body = workerResponse.body;

    for (const [key, value] of workerResponse.headers.entries()) {
      if (key.toLowerCase() !== "content-length") {
        ctx.response.headers.set(key, value);
      }
    }
  } catch (e: unknown) {
    ctx.response.status = 502;
    ctx.response.body = {
      error: "Worker unavailable: " +
        (e instanceof Error ? e.message : String(e)),
    };
  }
});

// 8. Serve Videos
router.get("/videos/:path*", async (ctx) => {
  const videoPath = ctx.params.path;
  if (!videoPath || videoPath.includes("..")) {
    ctx.throw(400, "Invalid path");
    return;
  }
  try {
    const fullPath = join(CONFIG.DATA_DIR, videoPath);
    const file = await Deno.open(fullPath, { read: true });
    const fileInfo = await file.stat();
    ctx.response.body = file;
    ctx.response.type = "video/mp4";
    ctx.response.headers.set("Content-Length", fileInfo.size.toString());
  } catch {
    ctx.response.status = 404;
  }
});

// 9. SSE
router.get("/api/events", async (ctx) => {
  const target = await ctx.sendEvents();
  sseService.addClient(target);
});

// 10. Processing Queue
router.get("/api/processing/status", (ctx) => {
  ctx.response.body = processingService.getStatus();
});

router.post("/api/processing/queue", async (ctx) => {
  let body;
  try {
    body = await ctx.request.body.json();
  } catch {
    ctx.throw(400);
    return;
  }

  const paths = body.paths;
  if (!Array.isArray(paths)) {
    ctx.throw(400, "paths must be an array");
    return;
  }

  const result = processingService.addToQueue(paths);
  ctx.response.body = result;
});

router.delete("/api/processing/queue", (ctx) => {
  ctx.response.body = processingService.clearQueue();
});
