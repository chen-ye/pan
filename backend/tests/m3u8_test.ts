import { assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import { m3u8Service } from "../src/services/m3u8.ts";

Deno.test("M3u8Service - parses fragmented MP4 and generates valid HLS playlist", async () => {
  const multiFragPath = "/home/cye/.gemini/antigravity-cli/brain/1b9967f8-4875-48f8-92d1-8b76834f8318/scratch/multi_frag.mp4";
  const result = await m3u8Service.parseFmp4(multiFragPath);

  assertNotEquals(result, null);
  if (!result) return;

  assertEquals(result.timescale, 15360);
  assertEquals(result.fragments.length, 10);
  assertNotEquals(result.initSize, 0);

  const playlist = m3u8Service.buildM3u8Content(result, "multi_frag.mp4");
  assertEquals(playlist.startsWith("#EXTM3U"), true);
  assertEquals(playlist.includes("#EXT-X-VERSION:7"), true);
  assertEquals(playlist.includes("#EXT-X-MAP:URI=\"multi_frag.mp4\""), true);
  assertEquals(playlist.includes("#EXT-X-BYTERANGE:"), true);
  assertEquals(playlist.includes("#EXT-X-ENDLIST"), true);
});

Deno.test("M3u8Service - returns null for non-fragmented faststart MP4", async () => {
  const faststartPath = "/home/cye/.gemini/antigravity-cli/brain/1b9967f8-4875-48f8-92d1-8b76834f8318/scratch/test_faststart.mp4";
  const result = await m3u8Service.parseFmp4(faststartPath);
  assertEquals(result, null);
});
