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

# MD Class mapping - MegaDetector uses numeric class IDs
# MDv5: 1=animal, 2=person, 3=vehicle
# MDv1000 may use different IDs, so we'll be flexible
CLASS_MAPPING = {
    1: 'animal',
    2: 'person',
    3: 'vehicle',
    '1': 'animal',
    '2': 'person',
    '3': 'vehicle',
}

from flask import Response, stream_with_context

def process_video_generator(rel_path):
    if model is None:
        yield json.dumps({"error": "Model not loaded"}) + "\n"
        return

    video_path = os.path.join(DATA_DIR, rel_path)
    if not os.path.exists(video_path):
        yield json.dumps({"error": "File not found"}) + "\n"
        return

    logger.info(f"Processing {video_path}...")
    yield json.dumps({"status": "starting", "path": video_path}) + "\n"

    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    results_list = []

    # Process every 2 frames
    if fps > 0:
        frame_interval = int(fps / 4)
    else:
        frame_interval = 30

    if frame_interval < 1:
        frame_interval = 1

    frame_count = 0
    processed_count = 0

    # Estimate total processed frames for progress
    est_total_processed = total_frames / frame_interval

    while cap.isOpened():
        ret, frame = cap.read()
        if not ret:
            break

        if frame_count % frame_interval == 0:
            # Conversion to PIL
            frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            pil_img = Image.fromarray(frame_rgb)

            # Inference
            result = model.generate_detections_one_image(pil_img)

            # Handle case where model returns None (e.g., invalid image)
            if result and 'detections' in result and result['detections']:
                for d in result['detections']:
                    if d['conf'] > 0.2:
                        cat_id = d['category']
                        # Map known classes, label unknown ones for visibility
                        class_name = CLASS_MAPPING.get(cat_id, f'unknown_{cat_id}')
                        x, y, w, h = d['bbox']
                        bbox = [x, y, x + w, y + h]

                        results_list.append({
                            "frame": frame_count,
                            "timestamp": frame_count / fps if fps > 0 else 0,
                            "category": class_name,
                            "conf": d['conf'],
                            "bbox": bbox
                        })

            processed_count += 1
            # Emit progress on every processed frame for real-time updates
            progress = min(processed_count / est_total_processed, 1.0)
            yield json.dumps({
                "status": "progress",
                "progress": progress,
                "frame": frame_count,
                "total_frames": total_frames
            }) + "\n"

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
        yield json.dumps({
            "status": "complete",
            "output": json_path,
            "detections_count": len(results_list)
        }) + "\n"
    except Exception as e:
        logger.error(f"Failed to save JSON: {e}")
        yield json.dumps({"error": "Failed to save results"}) + "\n"

@app.route('/process', methods=['POST'])
def handle_process():
    data = request.json
    path = data.get('path')
    if not path:
        return jsonify({"error": "No path provided"}), 400

    def generate():
        for chunk in process_video_generator(path):
            yield chunk
            # Force flush to ensure immediate streaming
            import sys
            sys.stdout.flush()

    response = Response(stream_with_context(generate()), mimetype='application/x-ndjson')
    response.headers['Cache-Control'] = 'no-cache'
    response.headers['X-Accel-Buffering'] = 'no'
    return response

@app.route('/status', methods=['GET'])
def status():
    return jsonify({
        "status": "ready" if model else "error",
        "device": device if 'device' in globals() else "cuda",
        "model": MODEL_VERSION
    })

@app.route('/stats', methods=['GET'])
def handle_stats():
    stats = {}
    if torch.cuda.is_available():
        stats['gpu_name'] = torch.cuda.get_device_name(0)
        free, total = torch.cuda.mem_get_info(0)
        stats['memory_free'] = free
        stats['memory_total'] = total
        stats['memory_used'] = total - free
    else:
        stats['error'] = "No CUDA device found"

    return jsonify(stats)

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
