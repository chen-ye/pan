import { assertAlmostEquals, assertEquals } from "@std/assert";
import {
  bucketDetectionMarkers,
  buildChronoUrl,
  buildFilmstripUrl,
  computeScrubPercent,
  computeScrubTimestamp,
  formatScrubTime,
} from "./scrubber.ts";

Deno.test("computeScrubTimestamp maps pointer position linearly and clamps out-of-bounds", () => {
  assertAlmostEquals(computeScrubTimestamp(100, 100, 400, 300), 0);
  assertAlmostEquals(computeScrubTimestamp(300, 100, 400, 300), 150);
  assertAlmostEquals(computeScrubTimestamp(500, 100, 400, 300), 300);

  // Clamped below 0 and above width
  assertAlmostEquals(computeScrubTimestamp(20, 100, 400, 300), 0);
  assertAlmostEquals(computeScrubTimestamp(900, 100, 400, 300), 300);

  // Degenerate width or duration returns 0 safely
  assertEquals(computeScrubTimestamp(250, 100, 0, 300), 0);
  assertEquals(computeScrubTimestamp(250, 100, 400, 0), 0);
  assertEquals(computeScrubTimestamp(250, 100, 400, Number.NaN), 0);
});

Deno.test("computeScrubPercent clamps percentage to [0, 100]", () => {
  assertAlmostEquals(computeScrubPercent(200, 100, 400), 25);
  assertEquals(computeScrubPercent(50, 100, 400), 0);
  assertEquals(computeScrubPercent(700, 100, 400), 100);
  assertEquals(computeScrubPercent(200, 100, 0), 0);
});

Deno.test("formatScrubTime formats MM:SS and H:MM:SS cleanly", () => {
  assertEquals(formatScrubTime(0), "00:00");
  assertEquals(formatScrubTime(7.9), "00:07");
  assertEquals(formatScrubTime(65), "01:05");
  assertEquals(formatScrubTime(959.4), "15:59");
  assertEquals(formatScrubTime(3661), "1:01:01");
  assertEquals(formatScrubTime(-5), "00:00");
});

Deno.test("buildChronoUrl and buildFilmstripUrl URL-encode video paths", () => {
  const path = "NVR-unprocessed/Backyard/2025/08/31/clip #1 & test.mp4";
  assertEquals(
    buildChronoUrl(path, 320),
    "/thumbnail/?mode=chrono&path=NVR-unprocessed%2FBackyard%2F2025%2F08%2F31%2Fclip%20%231%20%26%20test.mp4&size=320",
  );
  assertEquals(
    buildChronoUrl(path, 1280),
    "/thumbnail/?mode=chrono&path=NVR-unprocessed%2FBackyard%2F2025%2F08%2F31%2Fclip%20%231%20%26%20test.mp4&size=1280",
  );
  assertEquals(
    buildFilmstripUrl(path),
    "/thumbnail/?mode=filmstrip&path=NVR-unprocessed%2FBackyard%2F2025%2F08%2F31%2Fclip%20%231%20%26%20test.mp4",
  );
});

Deno.test("bucketDetectionMarkers deduplicates 0.5% bins and prioritizes animal > person > other", () => {
  const markers = bucketDetectionMarkers(
    [
      { category: "vehicle", timestamp: 50.0 },
      { category: "person", timestamp: 50.1 },
      { category: "animal", timestamp: 50.2 }, // same 0.5% bucket at 50% of 100s -> animal wins
      { category: "person", timestamp: 80.0 },
      { category: "vehicle", timestamp: 10.0 },
    ],
    100,
  );

  assertEquals(markers.length, 3);
  assertEquals(markers[0], { pct: 10, color: "#f00" });
  assertEquals(markers[1], { pct: 50, color: "#e91e63" });
  assertEquals(markers[2], { pct: 80, color: "#2196f3" });
  assertEquals(bucketDetectionMarkers([{ category: "animal", timestamp: 10 }], 0), []);
});
