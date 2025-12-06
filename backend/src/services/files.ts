import { join, relative } from "@std/path";
import { CONFIG } from "../config.ts";

export interface DirNode {
    name: string;
    path: string;
    children: DirNode[];
}

/**
 * Recursively builds a directory tree starting from the given path.
 * Returns an array of DirNode objects representing the directory structure.
 */
export async function getDirTree(currentPath: string, rootPath: string = CONFIG.DATA_DIR): Promise<DirNode[]> {
    const nodes: DirNode[] = [];

    try {
        for await (const entry of Deno.readDir(currentPath)) {
            if (entry.isDirectory) {
                const fullPath = join(currentPath, entry.name);
                const relativePath = relative(rootPath, fullPath);
                nodes.push({
                    name: entry.name,
                    path: relativePath,
                    children: await getDirTree(fullPath, rootPath)
                });
            }
        }
    } catch {
        // Directory not readable, return empty
    }

    nodes.sort((a, b) => a.name.localeCompare(b.name));
    return nodes;
}
