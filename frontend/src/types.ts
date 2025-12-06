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
}

export interface Result {
  detections: Detection[];
  metadata: {
    width: number;
    height: number;
  };
}
