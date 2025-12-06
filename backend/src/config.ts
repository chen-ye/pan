import { join } from "@std/path";

export const CONFIG = {
  DATA_DIR: Deno.env.get("DATA_DIR") || "./data",
  WORKER_URL: Deno.env.get("WORKER_URL") || "http://worker:5000",
  PORT: 8000,
  METADATA_FILE: "metadata.json", // Relative to DATA_DIR
};

export const GLOBAL_OPTS = {
  // Computed paths
  METADATA_PATH: join(CONFIG.DATA_DIR, CONFIG.METADATA_FILE),
};
