import { ensureDir, walk } from "@std/fs";
import { dirname, extname, join, relative } from "@std/path";
import { CONFIG } from "../config.ts";
import { normalizeLegacyFormat, Detection } from "../utils.ts";
import { sseService } from "./sse.ts";

export type VideoState = "unprocessed" | "candidate" | "blank" | "detected" | "annotated";

export interface VideoEntry {
  path: string;
  name: string;
  fullPath: string;
  size: number;
  mtime: number;
  duration?: number;
  processed?: boolean;
  state?: VideoState;
  stride?: number;
  classifications?: string[];
}

const CACHE_FILE = ".pan_library_cache.json";

export class LibraryService {
  private library: VideoEntry[] = [];
  private cache: Map<string, VideoEntry> = new Map();
  private saveTimeout: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    // Initial refresh
    // Load cache first, then refresh
    this.loadCache().then(() => this.refresh());
  }

  private isVideo(filename: string) {
    const ext = extname(filename).toLowerCase();
    return [".mp4", ".mov", ".avi", ".mkv", ".webm"].includes(ext);
  }

  async refresh() {
    console.log("Refreshing video library...");
    const tempLib: VideoEntry[] = [];

    // 1. Collect all video files first
    const entries: { path: string; name: string }[] = [];
    try {
        for await (const entry of walk(CONFIG.DATA_DIR)) {
            if (entry.isFile && this.isVideo(entry.name)) {
                entries.push({
                    path: entry.path,
                    name: entry.name
                });
            }
        }
    } catch(e) {
        console.error("Error walking directory", e);
        return;
    }

    console.log(`Found ${entries.length} video files. Processing metadata...`);

    // 2. Process metadata - FAST SCAN ONLY, no JSON reading
    for (const entry of entries) { // Revert to simple loop
         const relPath = relative(CONFIG.DATA_DIR, entry.path);
         let metadata: Partial<VideoEntry> = {};

         // Helper to reuse cache if mtime matches
         const cached = this.cache.get(relPath);
         try {
             const info = await Deno.stat(entry.path);
             const mtime = info.mtime?.getTime() || 0;

             if (cached && cached.mtime === mtime && cached.processed !== undefined && cached.state !== undefined) {
                 // Reuse cache
                 metadata = {
                     processed: cached.processed,
                     state: cached.state,
                     stride: cached.stride,
                     classifications: cached.classifications
                 };
             }

             tempLib.push({
               path: relPath,
               name: entry.name,
               fullPath: entry.path,
               size: info.size,
               mtime: mtime,
               ...metadata
             });
         } catch {
             // Skip if stat fails
         }
    }

    // Default sort by name
    tempLib.sort((a, b) => a.name.localeCompare(b.name));
    this.library = tempLib;

    // Update cache map with current library state
    this.cache.clear();
    for (const v of this.library) {
        this.cache.set(v.path, v);
    }
    this.saveCache();

    console.log(`Library refreshed. ${this.library.length} videos found.`);
    sseService.notifyUpdate();
  }

  async enrichEntry(entry: VideoEntry) {
      if (entry.processed !== undefined && entry.state !== undefined) return; // Already enriched

      const jsonPath = entry.fullPath + ".json";
      const legacyJsonPath = entry.fullPath.substring(0, entry.fullPath.lastIndexOf(".")) + ".json";

      let processed = false;
      let state: VideoState = "unprocessed";
      let stride: number | undefined = undefined;
      let classifications: string[] = [];

      try {
         const jInfo = await Deno.stat(jsonPath);
         processed = jInfo.size > 0;
      } catch {
          try {
              const jInfo = await Deno.stat(legacyJsonPath);
              processed = jInfo.size > 0;
          } catch { }
      }

      if (processed) {
          try {
              let text = "";
              try {
                 text = await Deno.readTextFile(jsonPath);
              } catch {
                 text = await Deno.readTextFile(legacyJsonPath);
              }
              // deno-lint-ignore no-explicit-any
              const rawData: any = JSON.parse(text);
              const data = normalizeLegacyFormat(rawData);
              if (data.detections && data.detections.length > 0) {
                  const cats = new Set<string>();
                  data.detections.forEach((d: Detection) => {
                      if (d.category) cats.add(d.category);
                  });
                  classifications = Array.from(cats).sort();
              }

              // Determine state & stride from rawData / screening info
              const screening = rawData.info?.screening;
              const img = rawData.images && rawData.images[0] ? rawData.images[0] : {};
              const isPartial = Boolean(img.partial || screening?.early_exit);
              const hasDetections = classifications.length > 0;

              if (hasDetections) {
                  state = isPartial ? "detected" : "annotated";
              } else {
                  if (screening) {
                      const completed: number[] = Array.isArray(screening.strides_completed)
                          ? screening.strides_completed
                          : [];
                      const minStride = completed.length > 0
                          ? Math.min(...completed)
                          : (screening.max_stride_evaluated || 24);

                      if (minStride <= 1) {
                          state = "blank";
                          stride = 1;
                      } else {
                          state = "candidate";
                          stride = minStride;
                      }
                  } else {
                      if (isPartial) {
                          state = "candidate";
                          stride = 4;
                      } else {
                          state = "blank";
                          stride = 1;
                      }
                  }
              }
          } catch {
              processed = false;
              state = "unprocessed";
          }
      } else {
          state = "unprocessed";
      }

      // Add 'Upload' tag if in upload directory
      if (entry.path.startsWith("NVR-upload/") || entry.path.includes("/NVR-upload/")) {
         classifications.push("Upload");
         classifications = Array.from(new Set(classifications)).sort();
      }

      entry.processed = processed;
      entry.state = state;
      entry.stride = stride;
      entry.classifications = classifications;

      // Update cache map and trigger save
      this.cache.set(entry.path, entry);
      this.debouncedSaveCache();
  }

  private async loadCache() {
      try {
          const cachePath = join(CONFIG.DATA_DIR, CACHE_FILE);
          const text = await Deno.readTextFile(cachePath);
          const data = JSON.parse(text) as VideoEntry[];
          this.cache = new Map(data.map(v => [v.path, v]));
          console.log(`Cache loaded. ${this.cache.size} entries.`);
      } catch {
          console.log("No existing cache file found or failed to load.");
      }
  }

  private debouncedSaveCache() {
      if (this.saveTimeout) clearTimeout(this.saveTimeout);
      this.saveTimeout = setTimeout(() => this.saveCache(), 2000);
  }

  private async saveCache() {
      try {
          const cachePath = join(CONFIG.DATA_DIR, CACHE_FILE);
          // Convert map values to array for JSON
          const data = Array.from(this.cache.values());
          await Deno.writeTextFile(cachePath, JSON.stringify(data));
      } catch (e) {
          console.error("Failed to save cache:", e);
      }
  }

  getVideos() {
    return this.library;
  }

  async deleteVideo(relPath: string) {
    if (relPath.includes("..")) throw new Error("Invalid path");
    const fullPath = join(CONFIG.DATA_DIR, relPath);

    await Deno.remove(fullPath);
    try {
      await Deno.remove(fullPath + ".json");
    } catch { /* JSON may not exist */ }
    try {
      await Deno.remove(fullPath + ".m3u8");
    } catch { /* m3u8 may not exist */ }

    this.library = this.library.filter((v) => v.path !== relPath);
  }

  async moveVideo(relPath: string): Promise<string> {
    if (relPath.includes("..")) throw new Error("Invalid path");

    let destRelPath = "";
    if (relPath.startsWith("NVR-blank/")) {
      destRelPath = relPath.replace("NVR-blank/", "NVR-upload/");
    } else if (relPath.startsWith("NVR-unprocessed/")) {
      destRelPath = relPath.replace("NVR-unprocessed/", "NVR-upload/");
    } else {
      throw new Error("Invalid source directory");
    }

    const fullSrcPath = join(CONFIG.DATA_DIR, relPath);
    const fullDestPath = join(CONFIG.DATA_DIR, destRelPath);

    await ensureDir(dirname(fullDestPath));
    await Deno.rename(fullSrcPath, fullDestPath);

    try {
      await Deno.rename(fullSrcPath + ".json", fullDestPath + ".json");
    } catch { /* JSON may not exist */ }
    try {
      await Deno.rename(fullSrcPath + ".m3u8", fullDestPath + ".m3u8");
    } catch { /* m3u8 may not exist */ }

    this.library = this.library.filter((v) => v.path !== relPath);
    return destRelPath;
  }
}

export const libraryService = new LibraryService();
