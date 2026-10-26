export interface Detection {
  category: string;
  category_id?: string;
  conf: number;
  timestamp: number;
  bbox: [number, number, number, number]; // [x_min, y_min, width, height] normalized
  frame_number?: number;
  frame?: number;
}

export interface LegacyAnnotation {
  img_id?: string;
  bbox?: number[][];
  category?: string[];
  confidence?: number[];
}

export const DEFAULT_DETECTION_CATEGORIES: Record<string, string> = {
  "1": "animal",
  "2": "person",
  "3": "vehicle",
};

export const NAME_TO_CATEGORY_ID: Record<string, string> = {
  animal: "1",
  person: "2",
  vehicle: "3",
};

// deno-lint-ignore no-explicit-any
export function normalizeLegacyFormat(data: any): any {
  if (!data || typeof data !== "object") {
    return data;
  }

  // 1. Standard MegaDetector format (has images array)
  if (data.images && Array.isArray(data.images) && data.images.length > 0) {
    const categories: Record<string, string> =
      data.detection_categories || DEFAULT_DETECTION_CATEGORIES;
    const img = data.images[0];
    const frameRate = img.frame_rate || 12.0;

    const normalizedDetections: Detection[] = (img.detections || []).map(
      (d: any) => {
        const catId = String(d.category);
        const catName = categories[catId] || catId;
        const frameNum =
          d.frame_number !== undefined
            ? d.frame_number
            : d.frame !== undefined
            ? d.frame
            : 0;
        const ts =
          d.timestamp !== undefined
            ? d.timestamp
            : frameRate > 0
            ? Number((frameNum / frameRate).toFixed(3))
            : 0;

        const rawBbox = d.bbox || [0, 0, 0, 0];
        const bbox: [number, number, number, number] = [
          rawBbox[0] ?? 0,
          rawBbox[1] ?? 0,
          rawBbox[2] ?? 0,
          rawBbox[3] ?? 0,
        ];

        return {
          category: catName,
          category_id: catId,
          conf: Number((d.conf || 0).toFixed(4)),
          bbox,
          frame: frameNum,
          frame_number: frameNum,
          timestamp: ts,
        };
      },
    );

    const metadata = {
      fps: frameRate,
      total_frames: img.total_frames || 0,
      width: img.width || 1920,
      height: img.height || 1080,
      partial: Boolean(img.partial),
      ...(img.partial_reason ? { partial_reason: img.partial_reason } : {}),
    };

    return {
      info: data.info || {
        format_version: "1.6",
        detector: "MDv1000-redwood",
      },
      detection_categories: categories,
      classification_categories: data.classification_categories,
      images: [
        {
          file: img.file || data.video || "",
          frame_rate: frameRate,
          frames_processed: img.frames_processed || [],
          total_frames: metadata.total_frames,
          width: metadata.width,
          height: metadata.height,
          partial: metadata.partial,
          partial_reason: metadata.partial_reason,
          detections: (img.detections || []).map((d: any, idx: number) => ({
            ...d,
            category: String(d.category),
            bbox: normalizedDetections[idx].bbox,
            frame_number: normalizedDetections[idx].frame_number,
            timestamp: normalizedDetections[idx].timestamp,
          })),
        },
      ],
      video: img.file || data.video || "",
      metadata,
      partial: metadata.partial,
      detections: normalizedDetections,
    };
  }

  // 2. Pre-migration legacy Pan format: { video, metadata, detections: [ { bbox: [x1, y1, x2, y2] } ] }
  if (data.video && Array.isArray(data.detections)) {
    const fps = data.metadata?.fps || 12.0;
    const width = data.metadata?.width || 1920;
    const height = data.metadata?.height || 1080;
    const totalFrames = data.metadata?.total_frames || 0;
    const isPartial = Boolean(data.metadata?.partial || data.partial);
    const partialReason = data.metadata?.partial_reason || data.partial_reason;

    const framesProcessedSet = new Set<number>();

    const normalizedDetections: Detection[] = data.detections.map((d: any) => {
      const rawCat = String(d.category ?? "1");
      const catName = DEFAULT_DETECTION_CATEGORIES[rawCat] || rawCat;
      const catId =
        NAME_TO_CATEGORY_ID[catName.toLowerCase()] ||
        (DEFAULT_DETECTION_CATEGORIES[rawCat] ? rawCat : "1");
      const frameNum =
        d.frame !== undefined
          ? d.frame
          : d.frame_number !== undefined
          ? d.frame_number
          : 0;
      framesProcessedSet.add(frameNum);

      const ts =
        d.timestamp !== undefined
          ? d.timestamp
          : fps > 0
          ? Number((frameNum / fps).toFixed(3))
          : 0;

      // Convert legacy corner bbox [x1, y1, x2, y2] -> [x, y, w, h]
      const rawBbox = d.bbox || [0, 0, 0, 0];
      let x1 = rawBbox[0] ?? 0;
      let y1 = rawBbox[1] ?? 0;
      let x2 = rawBbox[2] ?? 0;
      let y2 = rawBbox[3] ?? 0;

      if (x1 > 1.0 || y1 > 1.0 || x2 > 1.0 || y2 > 1.0) {
        x1 = Math.max(0, Math.min(1, x1 / width));
        y1 = Math.max(0, Math.min(1, y1 / height));
        x2 = Math.max(0, Math.min(1, x2 / width));
        y2 = Math.max(0, Math.min(1, y2 / height));
      }

      let w = Math.max(0, x2 - x1);
      let h = Math.max(0, y2 - y1);
      if (w === 0 && x2 > 0) w = x2;
      if (h === 0 && y2 > 0) h = y2;

      const bbox: [number, number, number, number] = [
        Number(x1.toFixed(5)),
        Number(y1.toFixed(5)),
        Number(w.toFixed(5)),
        Number(h.toFixed(5)),
      ];

      return {
        category: catName,
        category_id: catId,
        conf: Number((d.conf || 0).toFixed(4)),
        bbox,
        frame: frameNum,
        frame_number: frameNum,
        timestamp: ts,
      };
    });

    const framesProcessed = Array.from(framesProcessedSet).sort(
      (a, b) => a - b,
    );

    const metadata = {
      fps,
      total_frames: totalFrames,
      width,
      height,
      partial: isPartial,
      ...(partialReason ? { partial_reason: partialReason } : {}),
    };

    return {
      info: {
        format_version: "1.6",
        detector: "MDv1000-redwood",
      },
      detection_categories: DEFAULT_DETECTION_CATEGORIES,
      images: [
        {
          file: data.video,
          frame_rate: fps,
          frames_processed: framesProcessed,
          total_frames: totalFrames,
          width,
          height,
          partial: isPartial,
          partial_reason: partialReason,
          detections: normalizedDetections.map((d) => ({
            category: d.category_id || "1",
            conf: d.conf,
            bbox: d.bbox,
            frame_number: d.frame_number,
            timestamp: d.timestamp,
          })),
        },
      ],
      video: data.video,
      metadata,
      partial: isPartial,
      detections: normalizedDetections,
    };
  }

  // 3. Pre-2025 legacy annotations format: { video, metadata, annotations: [...] }
  if (data.annotations && Array.isArray(data.annotations)) {
    const detections: Detection[] = [];
    const framesProcessedSet = new Set<number>();
    const fileCategories: Record<string, string> = data.categories || {};
    const fps = data.metadata?.fps || 2;
    const totalFrames = data.annotations.length;
    let width = data.metadata?.width || 0;
    let height = data.metadata?.height || 0;

    // Detect 4K vs 1080p if dimensions are missing or coordinates exceed 1080p
    let has4kCoords = false;
    for (const ann of data.annotations) {
      if (ann.bbox) {
        for (const b of ann.bbox) {
          if (b && ((b[0] ?? 0) > 1920 || (b[1] ?? 0) > 1080 || (b[2] ?? 0) > 1920 || (b[3] ?? 0) > 1080)) {
            has4kCoords = true;
            break;
          }
        }
      }
      if (has4kCoords) break;
    }

    if (has4kCoords) {
      width = 3840;
      height = 2160;
    } else if (width <= 0 || height <= 0) {
      width = 1920;
      height = 1080;
    }

    data.annotations.forEach((ann: LegacyAnnotation) => {
      const frameNum = parseInt(ann.img_id || "0");
      framesProcessedSet.add(frameNum);
      const bboxes = ann.bbox || [];
      const categories = ann.category || [];
      const confidences = ann.confidence || [];

      for (let i = 0; i < bboxes.length; i++) {
        const rawBox = bboxes[i] || [0, 0, 0, 0];
        let x1 = rawBox[0] ?? 0;
        let y1 = rawBox[1] ?? 0;
        let x2 = rawBox[2] ?? 0;
        let y2 = rawBox[3] ?? 0;

        if (x1 > 1.0 || y1 > 1.0 || x2 > 1.0 || y2 > 1.0) {
          x1 = Math.max(0, Math.min(1, x1 / width));
          y1 = Math.max(0, Math.min(1, y1 / height));
          x2 = Math.max(0, Math.min(1, x2 / width));
          y2 = Math.max(0, Math.min(1, y2 / height));
        }

        let w = Math.max(0, x2 - x1);
        let h = Math.max(0, y2 - y1);
        if (w === 0 && x2 > 0) w = x2;
        if (h === 0 && y2 > 0) h = y2;

        const rawCat = categories[i];
        let catName: string;
        let catId: string;

        if (rawCat !== undefined && rawCat !== null) {
          const rawCatStr = String(rawCat);
          catName =
            fileCategories[rawCatStr] ||
            DEFAULT_DETECTION_CATEGORIES[rawCatStr] ||
            rawCatStr;
          catId =
            NAME_TO_CATEGORY_ID[catName.toLowerCase()] ||
            (DEFAULT_DETECTION_CATEGORIES[rawCatStr] ? rawCatStr : "1");
        } else {
          catName = "unknown";
          catId = "1";
        }

        detections.push({
          frame: frameNum,
          frame_number: frameNum,
          timestamp: Number((frameNum / fps).toFixed(3)),
          category: catName,
          category_id: catId,
          conf: Number((confidences[i] || 0).toFixed(4)),
          bbox: [
            Number(x1.toFixed(5)),
            Number(y1.toFixed(5)),
            Number(w.toFixed(5)),
            Number(h.toFixed(5)),
          ],
        });
      }
    });

    return {
      info: {
        format_version: "1.6",
        detector: "MDv1000-redwood",
      },
      detection_categories: DEFAULT_DETECTION_CATEGORIES,
      images: [
        {
          file: data.video || "unknown",
          frame_rate: fps,
          frames_processed: Array.from(framesProcessedSet).sort(
            (a, b) => a - b,
          ),
          total_frames: totalFrames,
          width,
          height,
          partial: false,
          detections: detections.map((d) => ({
            category: d.category_id || "1",
            conf: d.conf,
            bbox: d.bbox,
            frame_number: d.frame_number,
            timestamp: d.timestamp,
          })),
        },
      ],
      video: data.video || "unknown",
      metadata: {
        fps,
        total_frames: totalFrames,
        width,
        height,
      },
      detections,
    };
  }

  return data;
}
