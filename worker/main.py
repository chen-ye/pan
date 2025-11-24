import torch
from flask import Flask, request, jsonify
import cv2
import os
import json
import logging

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)

# Load Model
MODEL_PATH = "md_v1000.pt"
device = 'cuda' if torch.cuda.is_available() else 'cpu'
logger.info(f"Loading model from {MODEL_PATH} on {device}...")

try:
    # Load custom model from local file using torch.hub
    # We use the ultralytics/yolov5 repo to load the custom weights
    model = torch.hub.load('ultralytics/yolov5', 'custom', path=MODEL_PATH)
    logger.info("Model loaded successfully.")
except Exception as e:
    logger.error(f"Failed to load model: {e}")
    model = None

DATA_DIR = "/data"

def process_video_file(rel_path):
    if model is None:
        return {"error": "Model not loaded"}

    video_path = os.path.join(DATA_DIR, rel_path)
    if not os.path.exists(video_path):
        return {"error": "File not found"}

    logger.info(f"Processing {video_path}...")

    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    results_list = []

    # Process 2 frames per second to balance speed and accuracy
    if fps > 0:
        frame_interval = int(fps / 2)
    else:
        frame_interval = 30 # Fallback

    if frame_interval < 1:
        frame_interval = 1

    frame_count = 0

    while cap.isOpened():
        ret, frame = cap.read()
        if not ret:
            break

        if frame_count % frame_interval == 0:
            # Detection
            img = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            results = model(img)

            # Get normalized coordinates
            # results.xyxyn[0] contains [x1, y1, x2, y2, conf, cls]
            for *xyxy, conf, cls in results.xyxyn[0].tolist():
                if conf > 0.2: # Confidence threshold
                    class_index = int(cls)
                    class_name = model.names[class_index]

                    results_list.append({
                        "frame": frame_count,
                        "timestamp": frame_count / fps if fps > 0 else 0,
                        "category": class_name,
                        "conf": conf,
                        "bbox": xyxy # normalized [x1, y1, x2, y2]
                    })

        frame_count += 1

    cap.release()

    # Save JSON
    json_path = video_path + ".json"
    try:
        with open(json_path, "w") as f:
            json.dump({
                "video": rel_path,
                "metadata": {
                    "fps": fps,
                    "total_frames": total_frames,
                    "width": width,
                    "height": height
                },
                "detections": results_list
            }, f, indent=2)
        logger.info(f"Saved results to {json_path}")
    except Exception as e:
        logger.error(f"Failed to save JSON: {e}")
        return {"error": "Failed to save results"}

    return {
        "status": "complete",
        "output": json_path,
        "detections_count": len(results_list)
    }

@app.route('/process', methods=['POST'])
def handle_process():
    data = request.json
    path = data.get('path')
    if not path:
        return jsonify({"error": "No path provided"}), 400

    try:
        # In a real app, this should be async/queued
        res = process_video_file(path)
        return jsonify(res)
    except Exception as e:
        logger.error(f"Processing error: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/status', methods=['GET'])
def status():
    return jsonify({
        "status": "ready" if model else "error",
        "device": device,
        "model": MODEL_PATH
    })

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
