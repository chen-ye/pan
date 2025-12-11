export interface Detection {
  category: string;
  conf: number;
  timestamp: number;
  bbox: number[];
  frame?: number;
}

export interface LegacyAnnotation {
  img_id?: string;
  bbox?: number[][];
  category?: string[];
  confidence?: number[];
}

// deno-lint-ignore no-explicit-any
export function normalizeLegacyFormat(data: any): any {
  // Check if data has legacy format (annotations array)
  if (data.annotations && Array.isArray(data.annotations)) {
    // console.log("Converting legacy format to new format");
    const detections: Detection[] = [];

    data.annotations.forEach((ann: LegacyAnnotation) => {
      const frameNum = parseInt(ann.img_id || "0");
      const bboxes = ann.bbox || [];
      const categories = ann.category || [];
      const confidences = ann.confidence || [];

      // Each frame can have multiple detections
      for (let i = 0; i < bboxes.length; i++) {
        detections.push({
          frame: frameNum,
          timestamp: frameNum / 2, // Assume 2fps processing
          category: categories[i] || "unknown",
          conf: confidences[i] || 0,
          bbox: bboxes[i] || [0, 0, 0, 0],
        });
      }
    });

    return {
      video: data.video || "unknown",
      metadata: data.metadata || {
        fps: 2,
        total_frames: data.annotations.length,
        width: 1920,
        height: 1080,
      },
      detections: detections,
    };
  }

  // Already in new format
  return data;
}
