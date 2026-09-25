import { Router } from "@oak/oak";
import { join } from "@std/path";
import { CONFIG } from "./config.ts";
import { libraryService } from "./services/library.ts";
import { metadataService } from "./services/metadata.ts";
import { sseService } from "./services/sse.ts";
import { processingService } from "./services/processing.ts";
import { getDirTree } from "./services/files.ts";
import { normalizeLegacyFormat } from "./utils.ts";
import { m3u8Service } from "./services/m3u8.ts";

export const router = new Router();

// 1. Get Videos
// 1. Get Videos (Search)
router.post("/api/videos/search", async (ctx) => {
  let body: any = {};
  try {
    if (ctx.request.hasBody) {
        body = await ctx.request.body.json();
    }
  } catch {
    // Empty body is fine, use defaults
  }

  const page = parseInt(body.page || "1");
  const limit = parseInt(body.limit || "50");
  const dirs = Array.isArray(body.dirs) ? body.dirs : []; // Expect array of strings
  const tags = Array.isArray(body.tags) ? body.tags : []; // Expect array of strings
  const sortBy = body.sort || "name";
  const order = body.order || "asc";

  let filteredVideos = libraryService.getVideos();

  if (dirs.length > 0) {
    filteredVideos = filteredVideos.filter((v) => {
      return dirs.some((dir: string) => v.path === dir || v.path.startsWith(dir + "/"));
    });
  }

  // Simplification: LibraryService now caches metadata, so we don't need to read files here.
  // We can just filter directly on the video objects.

  // Sort ALL candidates first (metadata sort only, no tag info yet)
  filteredVideos.sort((a, b) => {
    let cmp = 0;
    if (sortBy === "size") {
        cmp = a.size - b.size;
    } else if (sortBy === "date") {
        cmp = a.mtime - b.mtime;
    } else {
        cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    }
    return order === "desc" ? -cmp : cmp;
  });

  const startIndex = (page - 1) * limit;
  const pageItems: any[] = [];
  let matchesFound = 0;
  let hasMore = false;

  // Lazy Scan
  for (const v of filteredVideos) {
      // 1. Enrich (load tags)
      await libraryService.enrichEntry(v);

      // 2. Filter by Tags
      let match = true;
      if (tags.length > 0) {
          match = false;
          if (tags.includes("Unprocessed") && !v.processed) match = true;
          else if (tags.includes("Blank") && v.processed && (!v.classifications || v.classifications.length === 0)) match = true;
          else if (v.processed && v.classifications && v.classifications.length > 0) {
              // deno-lint-ignore no-explicit-any
              if (tags.some((t: any) => v.classifications?.includes(t))) match = true;
          }
      }

      if (match) {
          if (matchesFound < startIndex) {
              matchesFound++;
              continue;
          }

          pageItems.push(v);
          // matchesFound not incremented for page items to keep logic simpler, we just track array

          if (pageItems.length > limit) {
              pageItems.pop(); // Remove the extra one
              hasMore = true;
              break;
          }
      }
  }

  // Map for response
  const mappedVideos = pageItems.map((v) => {
    return {
      path: v.path,
      name: v.name,
      processed: v.processed || false,
      size: v.size,
      classifications: v.classifications || [],
      duration: v.duration
    };
  });

  // Total will be reported as the cumulative count of videos loaded so far + current page
  // The frontend treats 'total' as the global count for pagination.
  // Since we don't know the full total without scanning everything, we Report:
  // startIndex + items.length (+1 if hasMore, maybe? No, let's stick to what we have)
  const logicalTotal = startIndex + mappedVideos.length;

  ctx.response.body = {
    items: mappedVideos,
    total: logicalTotal, // This makes the "Videos (X)" count grow as you load more
    page: page,
    limit: limit,
    hasMore: hasMore
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
    try {
        const fullPath = join(CONFIG.DATA_DIR, p);
        const duration = await metadataService.getDuration(fullPath);
        results[p] = duration;
    } catch (e) {
        console.error(`Failed to get duration for ${p}:`, e);
        results[p] = 0; // Or omit to indicate failure
    }
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

  const tryServe = async (path: string) => {
      const fullPath = join(CONFIG.DATA_DIR, path);
      try {
          const info = await Deno.stat(fullPath);
          if (info.size === 0) throw new Error("File empty");

          // Optional: Verify valid JSON (expensive for large files but requested)
          // For now, let's just trust valid size, or maybe read first byte?
          // If the user says "syntax error", the file has content but is bad.
          // Let's try to parse it. It's safe for most result files.
          const text = await Deno.readTextFile(fullPath);
          let json = JSON.parse(text); // Will throw if invalid
          json = normalizeLegacyFormat(json);

          ctx.response.body = JSON.stringify(json);
          ctx.response.type = "application/json";
          return true;
      } catch {
          return false;
      }
  };

  // Try standard path
  if (await tryServe(resultPath + ".json")) return;

  // Try legacy path
  const ext = resultPath.substring(resultPath.lastIndexOf("."));
  const legacyPath = resultPath.substring(0, resultPath.lastIndexOf("."));
  if ([".mp4", ".mov", ".avi", ".mkv", ".webm"].includes(ext.toLowerCase())) {
     if (await tryServe(legacyPath + ".json")) return;
  }

  ctx.response.status = 404;
  ctx.response.body = { error: "Result not found or corrupt" };
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

// 7.5 Get HLS M3U8 Playlist
router.get("/api/videos/m3u8", async (ctx) => {
  const videoPath = ctx.request.url.searchParams.get("path");
  if (!videoPath || videoPath.includes("..")) {
    ctx.throw(400, "Invalid path");
    return;
  }
  const playlist = await m3u8Service.getOrGenerateSidecar(videoPath);
  if (!playlist) {
    ctx.throw(404, "HLS playlist not available for this video");
    return;
  }
  ctx.response.status = 200;
  ctx.response.headers.set("Content-Type", "application/vnd.apple.mpegurl");
  ctx.response.headers.set("Access-Control-Allow-Origin", "*");
  ctx.response.body = playlist;
});

// 8. Serve Videos
router.get("/videos/:path*", async (ctx) => {
  const videoPath = ctx.params.path;
  if (!videoPath || videoPath.includes("..")) {
    ctx.throw(400, "Invalid path");
    return;
  }

  // Handle direct .m3u8 requests
  if (videoPath.endsWith(".m3u8")) {
    const relVideoPath = videoPath.slice(0, -5); // strip .m3u8
    const playlist = await m3u8Service.getOrGenerateSidecar(relVideoPath);
    if (!playlist) {
      ctx.throw(404, "HLS playlist not available for this video");
      return;
    }
    ctx.response.status = 200;
    ctx.response.headers.set("Content-Type", "application/vnd.apple.mpegurl");
    ctx.response.headers.set("Access-Control-Allow-Origin", "*");
    ctx.response.body = playlist;
    return;
  }

  try {
    // Do not use Oak.send, but directly stream the file. Oak.send seems to have issues with large files.
    const fullPath = join(CONFIG.DATA_DIR, videoPath);
    const file = await Deno.open(fullPath, { read: true });
    const fileInfo = await file.stat();
    const fileSize = fileInfo.size;

    const range = ctx.request.headers.get("Range");

    // Handle Range Requests (Seeking)
    if (range) {
        const bytes = range.replace(/bytes=/, "").split("-");
        const start = parseInt(bytes[0], 10);
        const end = bytes[1] ? parseInt(bytes[1], 10) : fileSize - 1;
        const chunkSize = (end - start) + 1;

        await file.seek(start, Deno.SeekMode.Start);

        ctx.response.status = 206;
        ctx.response.headers.set("Content-Range", `bytes ${start}-${end}/${fileSize}`);
        ctx.response.headers.set("Accept-Ranges", "bytes");
        ctx.response.headers.set("Content-Length", chunkSize.toString());
        ctx.response.type = "video/mp4";

        // Create a limited stream for the chunk
        // We can't just pass 'file' because it would read to EOF
        // We use a ReadableStream to control exactly how many bytes are sent
        const stream = new ReadableStream({
            async start(controller) {
                const buf = new Uint8Array(16 * 1024); // 16KB chunks
                let remaining = chunkSize;
                try {
                    while (remaining > 0) {
                        const readSize = Math.min(buf.length, remaining);
                        // We can't use file.read() easily with a buffer that size?
                        // Actually Deno.read reads UP TO buf.length
                        const n = await file.read(buf.subarray(0, readSize));
                        if (n === null || n === 0) break;

                        controller.enqueue(buf.slice(0, n));
                        remaining -= n;
                    }
                    controller.close();
                } catch (e) {
                    controller.error(e);
                } finally {
                    file.close();
                }
            },
            cancel() {
                file.close();
            }
        });

        ctx.response.body = stream;
    } else {
        // No Range, send whole file (but allows caching/seeking later if client supports)
        ctx.response.status = 200;
        ctx.response.headers.set("Content-Length", fileSize.toString());
        ctx.response.headers.set("Accept-Ranges", "bytes");
        ctx.response.type = "video/mp4";
        // Just stream the whole file, simplest way
        // But we need to ensure close happens. Oak handles FsFile closing usually?
        // Let's use the stream approach for consistency to guarantee closure
        const stream = new ReadableStream({
            async start(controller) {
                const buf = new Uint8Array(32 * 1024);
                try {
                   while (true) {
                       const n = await file.read(buf);
                       if (n === null || n === 0) break;
                       controller.enqueue(buf.slice(0, n));
                   }
                   controller.close();
                } catch(e) { console.error(e); controller.error(e); }
                finally { file.close(); }
            },
            cancel() { file.close(); }
        });
        ctx.response.body = stream;
    }

    ctx.response.headers.set("Access-Control-Allow-Origin", "*");
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
