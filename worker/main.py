import torch
from flask import Flask, request, jsonify
import cv2
import os
import json
import logging
from megadetector.detection import run_detector
from megadetector.visualization import visualization_utils as vis_utils

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)

# Load Model
# Using MDV5A as the stable default - MDv1000 produces invalid class IDs
MODEL_VERSION = "MDv1000-redwood"
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

    # Process every 4th frame (approx 3-8 fps depending on source)
    if fps > 0:
        frame_interval = int(fps / 4)
    else:
        frame_interval = 30

    if frame_interval < 1:
        frame_interval = 1

    frame_count = 0
    processed_count = 0
    est_total_processed = total_frames / frame_interval

    BATCH_SIZE = 8
    batch_images = [] # List of numpy arrays (RGB)
    batch_indices = [] # List of frame numbers

    while cap.isOpened():
        ret, frame = cap.read()
        if not ret:
            break

        if frame_count % frame_interval == 0:
            # Resize using OpenCV (Bilinear) - Much faster than PIL Lanczos
            # Target width 1280 (MDv5 standard max dim)
            target_size = 1280
            h, w = frame.shape[:2]
            max_dim = max(h, w)

            if max_dim > target_size:
                scale = target_size / max_dim
                new_w = int(w * scale)
                new_h = int(h * scale)
                frame_resized = cv2.resize(frame, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
            else:
                frame_resized = frame

            # Convert to RGB
            frame_rgb = cv2.cvtColor(frame_resized, cv2.COLOR_BGR2RGB)

            batch_images.append(frame_rgb)
            batch_indices.append(frame_count)

            # Process Batch
            if len(batch_images) >= BATCH_SIZE:
                # Run inference on batch
                # generate_detections_one_batch expects list of images and list of IDs
                batch_results = model.generate_detections_one_batch(batch_images, batch_indices)

                for res in batch_results:
                    frame_num = int(res['file']) # We used frame_count as ID

                    if res['detections']:
                        for d in res['detections']:
                            if d['conf'] > 0.2:
                                cat_id = d['category']
                                class_name = CLASS_MAPPING.get(cat_id, f'unknown_{cat_id}')
                                x, y, w, h = d['bbox']
                                bbox = [x, y, x + w, y + h]

                                results_list.append({
                                    "frame": frame_num,
                                    "timestamp": frame_num / fps if fps > 0 else 0,
                                    "category": class_name,
                                    "conf": d['conf'],
                                    "bbox": bbox
                                })

                    processed_count += 1

                # Emit result
                progress = min(processed_count / est_total_processed, 1.0)
                yield json.dumps({
                    "status": "progress",
                    "progress": progress,
                    "frame": batch_indices[-1],
                    "total_frames": total_frames
                }) + "\n"

                # Clear batch
                batch_images = []
                batch_indices = []

        frame_count += 1

    # Process remaining frames in batch
    if len(batch_images) > 0:
        batch_results = model.generate_detections_one_batch(batch_images, batch_indices)
        for res in batch_results:
            frame_num = int(res['file'])
            if res['detections']:
                for d in res['detections']:
                    if d['conf'] > 0.2:
                        cat_id = d['category']
                        class_name = CLASS_MAPPING.get(cat_id, f'unknown_{cat_id}')
                        x, y, w, h = d['bbox']
                        bbox = [x, y, x + w, y + h]
                        results_list.append({
                            "frame": frame_num,
                            "timestamp": frame_num / fps if fps > 0 else 0,
                            "category": class_name,
                            "conf": d['conf'],
                            "bbox": bbox
                        })
            processed_count += 1

        progress = min(processed_count / est_total_processed, 1.0)
        yield json.dumps({
            "status": "progress",
            "progress": progress,
            "frame": batch_indices[-1],
            "total_frames": total_frames
        }) + "\n"


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
    import subprocess
    stats = {}
    if torch.cuda.is_available():
        stats['gpu_name'] = torch.cuda.get_device_name(0)
        free, total = torch.cuda.mem_get_info(0)
        stats['memory_free'] = free
        stats['memory_total'] = total
        stats['memory_used'] = total - free

        # Get GPU utilization via nvidia-smi
        try:
            result = subprocess.run(
                ['nvidia-smi', '--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'],
                capture_output=True, text=True, timeout=5
            )
            if result.returncode == 0:
                stats['utilization'] = int(result.stdout.strip().split('\n')[0])
        except Exception:
            pass
    else:
        stats['error'] = "No CUDA device found"

    return jsonify(stats)

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
