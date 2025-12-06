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
}

export interface Detection {
  category: string;
  conf: number;
  timestamp: number;
  bbox: number[];
  frame?: number;
}

export interface Result {
  detections: Detection[];
  metadata: {
    width: number;
    height: number;
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
