import { join, relative } from "@std/path";
import { CONFIG, GLOBAL_OPTS } from "../config.ts";

export class MetadataService {
    private cache = new Map<string, any>();
    private dirty = false;

    constructor() {
        this.load();
        setInterval(() => this.save(), 5000);
    }

    private load() {
        console.log("Loading metadata cache...");
        try {
            const data = Deno.readTextFileSync(GLOBAL_OPTS.METADATA_PATH);
            const json = JSON.parse(data);
            for (const key in json) {
                this.cache.set(key, json[key]);
            }
            console.log("Metadata loaded.");
        } catch (e) {
            console.log("Metadata load skipped/failed (might be new):", e);
        }
    }

    private async save() {
        if (!this.dirty) return;
        this.dirty = false;
        try {
            await Deno.writeTextFile(GLOBAL_OPTS.METADATA_PATH, JSON.stringify(Object.fromEntries(this.cache)));
        } catch (e) {
            console.error("Failed to save metadata cache", e);
        }
    }

    async getDuration(fullPath: string): Promise<number | undefined> {
        const relPath = relative(CONFIG.DATA_DIR, fullPath);
        if (this.cache.has(relPath)) {
            return this.cache.get(relPath).duration;
        }

        const cmd = new Deno.Command("ffprobe", {
            args: [
                "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                fullPath
            ],
            stdout: "piped",
            stderr: "piped"
        });

        const output = await cmd.output();
        if (output.code === 0) {
            const durationStr = new TextDecoder().decode(output.stdout).trim();
            const duration = parseFloat(durationStr);
            if (!isNaN(duration)) {
                this.cache.set(relPath, { duration });
                this.dirty = true;
                return duration;
            }
        }
        return undefined;
    }
}

export const metadataService = new MetadataService();
