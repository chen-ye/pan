export interface TreeNode {
  name: string;
  path: string;
  children: TreeNode[];
}

export interface Video {
  path: string;
  name: string;
  processed: boolean;
  size: number;
  duration?: number;
  classifications?: string[];
}

export interface Detection {
  category: string;
  category_id?: string;
  conf: number;
  timestamp: number;
  bbox: [number, number, number, number]; // [x_min, y_min, width, height] normalized to [0, 1]
  frame_number?: number;
  frame?: number;
  classifications?: [string, number][];
}

export interface MegaDetectorImage {
  file: string;
  frame_rate?: number;
  frames_processed?: number[];
  total_frames?: number;
  width?: number;
  height?: number;
  partial?: boolean;
  partial_reason?: string;
  failure?: string | null;
  detections: Detection[];
}

export interface Result {
  info?: {
    format_version: string;
    detector?: string;
    detection_completion_time?: string;
    detector_metadata?: {
      image_size?: number;
      typical_detection_threshold?: number;
      conservative_detection_threshold?: number;
      precision?: "fp16" | "fp32" | string;
      [key: string]: unknown;
    };
  };
  detection_categories?: Record<string, string>;
  classification_categories?: Record<string, string>;
  images?: MegaDetectorImage[];

  // Normalized convenient top-level accessors
  detections: Detection[];
  metadata: {
    width: number;
    height: number;
    fps?: number;
    total_frames?: number;
    partial?: boolean;
    partial_reason?: string;
  };
}

export interface GpuStats {
  gpu_name?: string;
  memory_free?: number;
  memory_total?: number;
  memory_used?: number;
  utilization?: number;
  error?: string;
}
