"""ONNX Runtime GPU implementation of MegaDetector operating directly on GPU tensors."""

import logging
from pathlib import Path
from typing import Any

import numpy as np
import onnxruntime as ort
import torch
from detector import TorchVisionMegaDetector

logger = logging.getLogger(__name__)


class OnnxMegaDetector(TorchVisionMegaDetector):
    """Drop-in replacement for TorchVisionMegaDetector using onnxruntime-gpu.

    Executes aspect-ratio scaling, letterbox padding, and batched NMS directly on GPU
    tensors via Torchvision, while running model inference through ONNX Runtime with
    zero-copy IOBinding directly in VRAM.
    """

    def __init__(
        self,
        onnx_path: str | Path = "/tmp/megadetector_models/md_v1000.0.0-redwood.onnx",
        device: str | torch.device | None = None,
        default_image_size: int = 1280,
        letterbox_stride: int = 64,
        iou_threshold: float = 0.45,
        max_det: int = 300,
        fp16: bool = False,
    ) -> None:
        self.model_version = Path(onnx_path).stem
        self.onnx_path = str(Path(onnx_path).resolve())
        self.default_image_size = default_image_size
        self.letterbox_stride = letterbox_stride
        self.iou_threshold = iou_threshold
        self.max_det = max_det
        self.fp16 = fp16
        self.categories = {"1": "animal", "2": "person", "3": "vehicle"}

        if device is None:
            self.device = torch.device("cuda:0" if torch.cuda.is_available() else "cpu")
        elif isinstance(device, str):
            self.device = torch.device(device)
        else:
            self.device = device

        if self.device.type == "cuda":
            providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
        else:
            providers = ["CPUExecutionProvider"]

        sess_opts = ort.SessionOptions()
        sess_opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

        logger.info(
            "Initializing ONNX Runtime session for %s on %s...",
            self.onnx_path,
            self.device,
        )
        self.session = ort.InferenceSession(
            self.onnx_path, sess_options=sess_opts, providers=providers
        )
        self.input_name = self.session.get_inputs()[0].name
        self.output_name = self.session.get_outputs()[0].name
        self.io_binding = self.session.io_binding()

        logger.info(
            "OnnxMegaDetector ready: device=%s, fp16=%s, input=%s, output=%s",
            self.device,
            self.fp16,
            self.input_name,
            self.output_name,
        )

    def generate_detections_one_batch(
        self,
        frames: torch.Tensor | list[Any],
        image_ids: list[Any] | None = None,
        detection_threshold: float = 0.00001,
    ) -> list[dict[str, Any]]:
        x_norm, scale, (left, top), (orig_h, orig_w) = self.preprocess(frames)

        if self.fp16 and x_norm.dtype != torch.float16:
            x_input = x_norm.half().contiguous()
        elif not self.fp16 and x_norm.dtype != torch.float32:
            x_input = x_norm.float().contiguous()
        else:
            x_input = x_norm.contiguous()

        elem_type = np.float16 if self.fp16 else np.float32
        self.io_binding.bind_input(
            name=self.input_name,
            device_type="cuda" if x_input.is_cuda else "cpu",
            device_id=x_input.device.index or 0 if x_input.is_cuda else 0,
            element_type=elem_type,
            shape=tuple(x_input.shape),
            buffer_ptr=x_input.data_ptr(),
        )

        self.io_binding.bind_output(
            name=self.output_name,
            device_type="cuda" if x_input.is_cuda else "cpu",
            device_id=x_input.device.index or 0 if x_input.is_cuda else 0,
        )

        self.session.run_with_iobinding(self.io_binding)

        ort_out = self.io_binding.get_outputs()[0]
        preds = torch.from_dlpack(ort_out)
        preds_f32 = preds.float() if self.fp16 else preds

        return self.postprocess(
            preds_f32,
            scale=scale,
            pad=(left, top),
            orig_shape=(orig_h, orig_w),
            image_ids=image_ids,
            detection_threshold=detection_threshold,
        )


class OnnxStaticMegaDetector(OnnxMegaDetector):
    """Static-batch MegaDetector implementing Strategy A (dummy frame padding & output slicing)."""

    def __init__(
        self,
        onnx_path: str = "/tmp/megadetector_models/md_v1000.0.0-redwood_static_b8.onnx",
        static_batch_size: int = 8,
        static_height: int = 768,
        static_width: int = 1280,
        device: str | torch.device | None = None,
        default_image_size: int = 1280,
        letterbox_stride: int = 64,
        iou_threshold: float = 0.45,
        max_det: int = 300,
        fp16: bool = False,
    ) -> None:
        super().__init__(
            onnx_path=onnx_path,
            device=device,
            default_image_size=default_image_size,
            letterbox_stride=letterbox_stride,
            iou_threshold=iou_threshold,
            max_det=max_det,
            fp16=fp16,
        )
        self.static_batch_size = static_batch_size
        self.static_height = static_height
        self.static_width = static_width

        input_dtype = torch.float16 if self.fp16 else torch.float32
        out_dtype = torch.float16 if self.fp16 else torch.float32
        in_elem_type = np.float16 if self.fp16 else np.float32
        out_elem_type = np.float16 if self.fp16 else np.float32

        # Pre-allocate static input and output tensors directly on GPU
        self.static_input = torch.zeros(
            (self.static_batch_size, 3, self.static_height, self.static_width),
            dtype=input_dtype,
            device=self.device,
        )

        out_shape = tuple(self.session.get_outputs()[0].shape)
        self.static_output = torch.zeros(
            out_shape,
            dtype=out_dtype,
            device=self.device,
        )

        # Pre-bind once at initialization time to avoid per-inference binding overhead
        self.io_binding.bind_input(
            name=self.input_name,
            device_type="cuda" if self.device.type == "cuda" else "cpu",
            device_id=self.device.index or 0 if self.device.type == "cuda" else 0,
            element_type=in_elem_type,
            shape=tuple(self.static_input.shape),
            buffer_ptr=self.static_input.data_ptr(),
        )

        self.io_binding.bind_output(
            name=self.output_name,
            device_type="cuda" if self.device.type == "cuda" else "cpu",
            device_id=self.device.index or 0 if self.device.type == "cuda" else 0,
            element_type=out_elem_type,
            shape=tuple(self.static_output.shape),
            buffer_ptr=self.static_output.data_ptr(),
        )

    def generate_detections_one_batch(
        self,
        frames: torch.Tensor | list[Any],
        image_ids: list[Any] | None = None,
        detection_threshold: float = 0.00001,
    ) -> list[dict[str, Any]]:
        """Run detector on a batch of up to `static_batch_size` frames via Strategy A."""
        x_norm, scale, (left, top), (orig_h, orig_w) = self.preprocess(frames)
        k = x_norm.shape[0]
        if k > self.static_batch_size:
            raise ValueError(
                f"Batch size {k} exceeds static batch size {self.static_batch_size}"
            )

        # 1. Fill static buffer with active frames (Strategy A)
        if self.fp16 and x_norm.dtype != torch.float16:
            x_input = x_norm.half()
        elif not self.fp16 and x_norm.dtype != torch.float32:
            x_input = x_norm.float()
        else:
            x_input = x_norm

        self.static_input[:k].copy_(x_input)
        if k < self.static_batch_size:
            self.static_input[k:].zero_()

        # 2. Execute static engine with pre-bound zero-copy buffers
        self.session.run_with_iobinding(self.io_binding)

        # 3. Slice out only the valid predictions (Strategy A output slicing)
        valid_preds = self.static_output[:k]
        valid_preds_f32 = valid_preds.float() if self.fp16 else valid_preds

        return self.postprocess(
            valid_preds_f32,
            scale=scale,
            pad=(left, top),
            orig_shape=(orig_h, orig_w),
            image_ids=image_ids,
            detection_threshold=detection_threshold,
        )
