/* global ort */

const ORT_BASE = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/";
const MODEL_URL = "/models/ppe.onnx";
const INPUT_SIZE = 640;
const CLASS_NAMES = [
  "Fall-Detected",
  "Gloves",
  "Goggles",
  "Hardhat",
  "Mask",
  "NO-Gloves",
  "NO-Goggles",
  "NO-Hardhat",
  "NO-Mask",
  "NO-Safety Vest",
  "No_Harness",
  "Person",
  "Safety Vest",
];

let session = null;
let loadingPromise = null;
let canvas = null;
let ctx = null;

function post(type, payload = {}) {
  self.postMessage({ type, ...payload });
}

async function loadRuntime() {
  if (self.ort) return;
  importScripts(`${ORT_BASE}ort.min.js`);
  ort.env.wasm.wasmPaths = ORT_BASE;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.simd = true;
}

async function fetchWithProgress(url) {
  const response = await fetch(url, { cache: "force-cache", credentials: "same-origin" });
  if (!response.ok) throw new Error(`보호구 모델 다운로드 실패 (${response.status})`);
  const total = Number(response.headers.get("content-length") || 0);
  if (!response.body) return response.arrayBuffer();

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    post("model-progress", {
      loaded: received,
      total,
      percent: total ? Math.min(99, Math.round((received / total) * 100)) : 0,
    });
  }

  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

async function ensureSession() {
  if (session) return session;
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    post("model-status", { status: "runtime", message: "AI 실행환경 준비 중" });
    await loadRuntime();
    post("model-status", { status: "download", message: "보호구 모델 다운로드 중" });
    const modelBuffer = await fetchWithProgress(MODEL_URL);
    post("model-status", { status: "compile", message: "보호구 모델 최적화 중" });
    session = await ort.InferenceSession.create(modelBuffer, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
      enableCpuMemArena: true,
      enableMemPattern: true,
    });
    post("model-ready", {
      inputName: session.inputNames[0],
      outputName: session.outputNames[0],
      classes: CLASS_NAMES,
    });
    return session;
  })().catch((error) => {
    post("model-error", { message: error?.message || String(error) });
    loadingPromise = null;
    throw error;
  });
  return loadingPromise;
}

function ensureCanvas() {
  if (!canvas) {
    canvas = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE);
    ctx = canvas.getContext("2d", { willReadFrequently: true });
  }
}

function preprocess(bitmap) {
  ensureCanvas();
  const sourceWidth = bitmap.width;
  const sourceHeight = bitmap.height;
  const scale = Math.min(INPUT_SIZE / sourceWidth, INPUT_SIZE / sourceHeight);
  const drawWidth = Math.round(sourceWidth * scale);
  const drawHeight = Math.round(sourceHeight * scale);
  const padX = Math.floor((INPUT_SIZE - drawWidth) / 2);
  const padY = Math.floor((INPUT_SIZE - drawHeight) / 2);

  ctx.fillStyle = "rgb(114,114,114)";
  ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  ctx.drawImage(bitmap, padX, padY, drawWidth, drawHeight);
  bitmap.close();

  const rgba = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data;
  const plane = INPUT_SIZE * INPUT_SIZE;
  const input = new Float32Array(plane * 3);
  for (let i = 0, pixel = 0; i < rgba.length; i += 4, pixel += 1) {
    input[pixel] = rgba[i] / 255;
    input[plane + pixel] = rgba[i + 1] / 255;
    input[plane * 2 + pixel] = rgba[i + 2] / 255;
  }

  return { input, sourceWidth, sourceHeight, scale, padX, padY };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1);
  const areaB = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
  return intersection / Math.max(1e-6, areaA + areaB - intersection);
}

function nms(candidates, threshold = 0.45, maxDetections = 80) {
  const grouped = new Map();
  for (const item of candidates) {
    if (!grouped.has(item.classId)) grouped.set(item.classId, []);
    grouped.get(item.classId).push(item);
  }

  const kept = [];
  for (const group of grouped.values()) {
    group.sort((a, b) => b.score - a.score);
    while (group.length && kept.length < maxDetections) {
      const current = group.shift();
      kept.push(current);
      for (let i = group.length - 1; i >= 0; i -= 1) {
        if (iou(current, group[i]) > threshold) group.splice(i, 1);
      }
    }
  }
  return kept.sort((a, b) => b.score - a.score).slice(0, maxDetections);
}

function confidenceThreshold(classId, base) {
  if ([7, 6, 10, 0].includes(classId)) return Math.max(0.22, base - 0.06);
  if ([3, 2, 11].includes(classId)) return Math.max(0.24, base - 0.03);
  return base;
}

function parseOutput(tensor, meta, baseThreshold) {
  const dims = tensor.dims;
  const data = tensor.data;
  let channels;
  let anchors;
  let channelFirst;

  if (dims.length === 3 && dims[1] <= 64) {
    channels = dims[1];
    anchors = dims[2];
    channelFirst = true;
  } else if (dims.length === 3) {
    anchors = dims[1];
    channels = dims[2];
    channelFirst = false;
  } else {
    throw new Error(`지원하지 않는 모델 출력 형태: ${dims.join("x")}`);
  }

  const classCount = Math.min(CLASS_NAMES.length, channels - 4);
  const at = channelFirst
    ? (anchor, channel) => data[channel * anchors + anchor]
    : (anchor, channel) => data[anchor * channels + channel];

  const candidates = [];
  for (let anchor = 0; anchor < anchors; anchor += 1) {
    let bestClass = -1;
    let bestScore = 0;
    for (let classId = 0; classId < classCount; classId += 1) {
      const score = at(anchor, classId + 4);
      if (score > bestScore) {
        bestScore = score;
        bestClass = classId;
      }
    }
    if (bestClass < 0 || bestScore < confidenceThreshold(bestClass, baseThreshold)) continue;

    const cx = at(anchor, 0);
    const cy = at(anchor, 1);
    const width = at(anchor, 2);
    const height = at(anchor, 3);

    let x1 = (cx - width / 2 - meta.padX) / meta.scale;
    let y1 = (cy - height / 2 - meta.padY) / meta.scale;
    let x2 = (cx + width / 2 - meta.padX) / meta.scale;
    let y2 = (cy + height / 2 - meta.padY) / meta.scale;

    x1 = clamp(x1, 0, meta.sourceWidth);
    y1 = clamp(y1, 0, meta.sourceHeight);
    x2 = clamp(x2, 0, meta.sourceWidth);
    y2 = clamp(y2, 0, meta.sourceHeight);
    if (x2 - x1 < 4 || y2 - y1 < 4) continue;

    candidates.push({
      classId: bestClass,
      label: CLASS_NAMES[bestClass],
      score: Number(bestScore),
      x1,
      y1,
      x2,
      y2,
      x: x1,
      y: y1,
      width: x2 - x1,
      height: y2 - y1,
    });
  }
  return nms(candidates);
}

async function infer(bitmap, threshold = 0.31) {
  const activeSession = await ensureSession();
  const started = performance.now();
  const meta = preprocess(bitmap);
  const tensor = new ort.Tensor("float32", meta.input, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const outputs = await activeSession.run({ [activeSession.inputNames[0]]: tensor });
  const output = outputs[activeSession.outputNames[0]];
  const detections = parseOutput(output, meta, threshold);
  return {
    detections,
    sourceWidth: meta.sourceWidth,
    sourceHeight: meta.sourceHeight,
    inferenceMs: performance.now() - started,
  };
}

self.onmessage = async (event) => {
  const message = event.data || {};
  if (message.type === "load") {
    try { await ensureSession(); } catch { /* error already posted */ }
    return;
  }
  if (message.type === "infer" && message.bitmap) {
    try {
      const result = await infer(message.bitmap, Number(message.threshold || 0.31));
      post("result", { requestId: message.requestId, ...result });
    } catch (error) {
      try { message.bitmap.close(); } catch { /* noop */ }
      post("inference-error", { requestId: message.requestId, message: error?.message || String(error) });
    }
  }
};
