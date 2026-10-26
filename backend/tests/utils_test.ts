import { assertEquals } from "@std/assert";
import { normalizeLegacyFormat } from "../src/utils.ts";

Deno.test("normalizeLegacyFormat - resolves legacy annotations format with file categories", () => {
  const legacyData = {
    video: "Backyard_00_20240724142323.mp4",
    categories: {
      "0": "animal",
      "1": "person",
      "2": "vehicle",
    },
    metadata: {
      fps: 2,
      total_frames: 10,
      width: 3840,
      height: 2160,
    },
    annotations: [
      {
        img_id: "100",
        bbox: [[0, 540, 384, 1080]], // Absolute pixels
        category: [0], // 0 is 'animal'
        confidence: [0.95],
      },
      {
        img_id: "200",
        bbox: [[384, 0, 768, 540]],
        category: [1], // 1 is 'person'
        confidence: [0.88],
      },
    ],
  };

  const normalized = normalizeLegacyFormat(legacyData);

  assertEquals(normalized.info.format_version, "1.6");
  assertEquals(normalized.detection_categories, {
    "1": "animal",
    "2": "person",
    "3": "vehicle",
  });

  const dets = normalized.detections;
  assertEquals(dets.length, 2);

  // First detection: Animal
  assertEquals(dets[0].category, "animal");
  assertEquals(dets[0].category_id, "1");
  assertEquals(dets[0].conf, 0.95);
  assertEquals(dets[0].frame_number, 100);
  assertEquals(dets[0].timestamp, 50);
  // [0/3840, 540/2160, 384/3840, 540/2160] -> [0, 0.25, 0.1, 0.25]
  assertEquals(dets[0].bbox, [0, 0.25, 0.1, 0.25]);

  // Second detection: Person
  assertEquals(dets[1].category, "person");
  assertEquals(dets[1].category_id, "2");
  assertEquals(dets[1].conf, 0.88);
  assertEquals(dets[1].frame_number, 200);
  assertEquals(dets[1].timestamp, 100);
});

Deno.test("normalizeLegacyFormat - resolves legacy flat detections with numeric IDs", () => {
  const legacyData = {
    video: "Backyard_00_20260502214230.mp4",
    metadata: {
      fps: 12.0,
      total_frames: 1200,
      width: 1920,
      height: 1080,
    },
    detections: [
      {
        category: "1", // numeric ID
        conf: 0.92,
        frame: 12,
        bbox: [192, 108, 384, 324], // corner absolute coords
      },
    ],
  };

  const normalized = normalizeLegacyFormat(legacyData);
  assertEquals(normalized.detections[0].category, "animal");
  assertEquals(normalized.detections[0].category_id, "1");
  assertEquals(normalized.detections[0].bbox, [0.1, 0.1, 0.1, 0.2]);
});
