import { ensureDir, walk } from "@std/fs";
import { dirname, extname, join, relative } from "@std/path";
import { CONFIG } from "../config.ts";
import { sseService } from "./sse.ts";

export interface VideoEntry {
  path: string;
  name: string;
  fullPath: string;
}

export class LibraryService {
  private library: VideoEntry[] = [];

  constructor() {
    // Initial refresh
    setTimeout(() => this.refresh(), 100);
  }

  private isVideo(filename: string) {
    const ext = extname(filename).toLowerCase();
    return [".mp4", ".mov", ".avi", ".mkv", ".webm"].includes(ext);
  }

  async refresh() {
    console.log("Refreshing video library...");
    const tempLib: VideoEntry[] = [];
    try {
      for await (const entry of walk(CONFIG.DATA_DIR)) {
        if (entry.isFile && this.isVideo(entry.name)) {
          const relPath = relative(CONFIG.DATA_DIR, entry.path);
          tempLib.push({
            path: relPath,
            name: entry.name,
            fullPath: entry.path,
          });
        }
      }
      tempLib.sort((a, b) => a.name.localeCompare(b.name));
      this.library = tempLib;
      console.log(`Library refreshed. ${this.library.length} videos found.`);
      sseService.notifyUpdate();
    } catch (e) {
      console.error("Error refreshing library", e);
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

    this.library = this.library.filter((v) => v.path !== relPath);
    return destRelPath;
  }
}

export const libraryService = new LibraryService();
