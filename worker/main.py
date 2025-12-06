import torch
from flask import Flask, request, jsonify
import cv2
import os
import json
import logging
from PIL import Image
from megadetector.detection import run_detector
from megadetector.visualization import visualization_utils as vis_utils

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)

# Load Model
# Using MDv5a as the stable default in the v1000 package ecosystem.
# If a specific v1000 model alias is available (e.g. 'MDV1000'), update here.
MODEL_VERSION = "mdv1000-cedar"
logger.info(f"Loading MegaDetector model: {MODEL_VERSION}...")

try:
    model = run_detector.load_detector(MODEL_VERSION)
    logger.info("Model loaded successfully.")
except Exception as e:
    logger.error(f"Failed to load model: {e}")
    model = None

DATA_DIR = "/data"

# MD Class mapping
CLASS_MAPPING = {
    '1': 'animal',
    '2': 'person',
    '3': 'vehicle'
}

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

    # Process 2 frames per second
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
            # Conversion to PIL for MegaDetector
            frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            pil_img = Image.fromarray(frame_rgb)

            # Inference
            result = model.generate_detections_one_image(pil_img)

            # result['detections'] is a list of dicts: {'category': '1', 'conf': 0.9, 'bbox': [x, y, w, h]}
            for d in result['detections']:
                if d['conf'] > 0.2:
                    cat_id = d['category']
                    class_name = CLASS_MAPPING.get(cat_id, str(cat_id))

                    # Convert [x, y, w, h] to [x1, y1, x2, y2]
                    x, y, w, h = d['bbox']
                    bbox = [x, y, x + w, y + h]

                    results_list.append({
                        "frame": frame_count,
                        "timestamp": frame_count / fps if fps > 0 else 0,
                        "category": class_name,
                        "conf": d['conf'],
                        "bbox": bbox
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
        "device": device if 'device' in globals() else "cuda",
        "model": MODEL_VERSION
    })

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
