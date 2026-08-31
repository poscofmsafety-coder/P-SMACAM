import { DurableObject } from "cloudflare:workers";
import { SAFETY_PHOTO_PROMPT } from "./safety-photo-prompt.js";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

let schemaReady = false;
let schemaPromise = null;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    site TEXT NOT NULL DEFAULT '',
    area TEXT NOT NULL DEFAULT '',
    camera_label TEXT NOT NULL DEFAULT '브라우저 카메라',
    status TEXT NOT NULL DEFAULT 'offline',
    agent_version TEXT NOT NULL DEFAULT '',
    last_seen TEXT,
    fps REAL NOT NULL DEFAULT 0,
    cpu REAL NOT NULL DEFAULT 0,
    memory REAL NOT NULL DEFAULT 0,
    people_count INTEGER NOT NULL DEFAULT 0,
    current_risk TEXT NOT NULL DEFAULT '정상',
    preview_key TEXT,
    config_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    type TEXT NOT NULL,
    category TEXT NOT NULL,
    severity TEXT NOT NULL,
    message TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    acknowledged INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT '확인 필요',
    snapshot_key TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS media (
    key TEXT PRIMARY KEY,
    content_type TEXT NOT NULL DEFAULT 'image/jpeg',
    bytes BLOB NOT NULL,
    byte_length INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS work_stop_requests (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    requester_name TEXT NOT NULL DEFAULT '',
    requester_contact TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT '요청',
    requested_at TEXT NOT NULL,
    acknowledged_at TEXT,
    resolved_at TEXT,
    snapshot_key TEXT,
    email_status TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS photo_analyses (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    image_key TEXT,
    provider TEXT NOT NULL DEFAULT '',
    analysis_text TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'medium',
    email_status TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tbm_sessions (
    id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    work_date TEXT NOT NULL DEFAULT '',
    source_email TEXT NOT NULL DEFAULT '',
    email_body TEXT NOT NULL,
    summary_text TEXT NOT NULL,
    manager_email TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '진행',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tbm_feedback (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    device_id TEXT NOT NULL DEFAULT '',
    worker_name TEXT NOT NULL DEFAULT '',
    opinion TEXT NOT NULL,
    ai_recommendation TEXT NOT NULL DEFAULT '',
    email_status TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ppe_feedback (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    predicted_json TEXT NOT NULL DEFAULT '{}',
    actual_json TEXT NOT NULL DEFAULT '{}',
    image_key TEXT,
    model_version TEXT NOT NULL DEFAULT '',
    reviewed INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ppe_feedback_created_at ON ppe_feedback(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_media_updated_at ON media(updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_events_occurred_at ON events(occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_events_device_id ON events(device_id)`,
  `CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices(last_seen DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_work_stop_requested_at ON work_stop_requests(requested_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_photo_analyses_created_at ON photo_analyses(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_tbm_sessions_created_at ON tbm_sessions(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_tbm_feedback_created_at ON tbm_feedback(created_at DESC)`,
];

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
}

function error(message, status = 400, details = undefined) {
  return json({ ok: false, error: message, details }, status);
}

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function safeJsonParse(value, fallback = {}) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

async function readJson(request) {
  try { return await request.json(); } catch { throw new Error("요청 본문이 올바른 JSON이 아닙니다."); }
}

function defaultConfig() {
  return {
    version: 7,
    zones: [],
    rules: {
      dangerZone: false,
      helmet: true,
      safetyGlasses: true,
      mask: true,
      harness: false,
      hookConnected: false,
      fall: true,
      unsafePosture: false,
      longStay: false,
      forklift: false,
      heavyEquipmentProximity: false,
      crane: false,
      agv: false,
      obstacle: false,
      blockedAisle: false,
      smoke: false,
      fire: false,
    },
    voice: { enabled: true, cooldownSeconds: 12, volume: 0.95 },
    detection: { confidence: 0.28, consecutiveFrames: 3, intervalMs: 1000, inferMissingPpeFromPerson: true, fallbackPpeFromAnyAnchor: true, forceFacePpeFallback: true, conservativePpeAlert: true, minPersonHeightRatio: 0.16, fallbackNegativeScore: 0.62, gogglesPositiveMinScore: 0.44, maskPositiveMinScore: 0.46, helmetPositiveMinScore: 0.36 },
  };
}

function normalizeConfig(value) {
  const defaults = defaultConfig();
  const config = value && typeof value === "object" ? value : {};
  const incomingVersion = Number(config.version || 0);
  const normalized = {
    ...defaults,
    ...config,
    version: Math.max(incomingVersion, defaults.version),
    zones: Array.isArray(config.zones) ? config.zones : defaults.zones,
    rules: { ...defaults.rules, ...(config.rules || {}) },
    voice: { ...defaults.voice, ...(config.voice || {}) },
    detection: { ...defaults.detection, ...(config.detection || {}) },
  };

  if (incomingVersion < 6) {
    normalized.rules.safetyGlasses = true;
    normalized.rules.mask = true;
    normalized.detection.inferMissingPpeFromPerson = true;
    normalized.detection.fallbackPpeFromAnyAnchor = true;
    normalized.detection.forceFacePpeFallback = true;
    normalized.detection.fallbackNegativeScore = defaults.detection.fallbackNegativeScore;
  }

  return normalized;
}

async function ensureSchema(env) {
  if (schemaReady) return;
  if (!env.DB) throw new Error("D1 바인딩 DB가 없습니다.");
  if (!schemaPromise) {
    schemaPromise = env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql)))
      .then(() => { schemaReady = true; })
      .catch((err) => { schemaPromise = null; throw err; });
  }
  await schemaPromise;
}

/* ---------- Signed session cookie ---------- */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64UrlEncode(input) {
  const bytes = input instanceof Uint8Array ? input : encoder.encode(String(input));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function base64UrlDecode(input) {
  const normalized = input.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return base64UrlEncode(new Uint8Array(signature));
}

function parseCookies(request) {
  const result = {};
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return result;
}

async function createSession(role, env) {
  const payload = { role, exp: Date.now() + 12 * 60 * 60 * 1000, sid: crypto.randomUUID() };
  const encoded = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmac(encoded, env.SESSION_SECRET || "CHANGE_ME_SMART_SAFETY_SESSION_SECRET");
  return { token: `${encoded}.${signature}`, payload };
}

async function readSession(request, env) {
  const token = parseCookies(request).ssf_session;
  if (!token) return null;
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;
  const expected = await hmac(encoded, env.SESSION_SECRET || "CHANGE_ME_SMART_SAFETY_SESSION_SECRET");
  if (expected.length !== signature.length) return null;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i += 1) mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  if (mismatch) return null;
  try {
    const payload = JSON.parse(decoder.decode(base64UrlDecode(encoded)));
    if (!payload.exp || payload.exp < Date.now() || !["admin", "user"].includes(payload.role)) return null;
    return payload;
  } catch { return null; }
}

function sessionCookie(token, request, maxAge = 43200) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `ssf_session=${token}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${maxAge}`;
}

async function requireSession(request, env, role = null) {
  const session = await readSession(request, env);
  if (!session) return { response: error("로그인이 필요합니다.", 401) };
  if (role && session.role !== role) return { response: error("권한이 없습니다.", 403) };
  return { session };
}

/* ---------- Durable Object WebSocket signaling ---------- */

export class SignalingRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
  }

  peers(excludeClientId = null) {
    const peers = [];
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() || {};
      if (attachment.clientId && attachment.clientId !== excludeClientId) peers.push(attachment);
    }
    return peers;
  }

  send(socket, payload) {
    try { socket.send(JSON.stringify(payload)); } catch { /* disconnected */ }
  }

  broadcast(payload, excludeClientId = null, targetClientId = null) {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() || {};
      if (excludeClientId && attachment.clientId === excludeClientId) continue;
      if (targetClientId && attachment.clientId !== targetClientId) continue;
      this.send(socket, payload);
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname.endsWith("/broadcast")) {
      const payload = await request.json().catch(() => null);
      if (!payload || typeof payload !== "object") return json({ ok: false }, 400);
      this.broadcast({ ...payload, at: payload.at || nowIso() });
      return json({ ok: true });
    }
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected websocket", { status: 426 });
    const role = url.searchParams.get("role") || "unknown";
    const clientId = url.searchParams.get("clientId") || crypto.randomUUID();
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [role, clientId]);
    server.serializeAttachment({ role, clientId });
    this.send(server, { type: "connected", role, clientId, peers: this.peers(clientId), at: nowIso() });
    this.broadcast({ type: "peer-joined", role, clientId, at: nowIso() }, clientId);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, rawMessage) {
    const sender = socket.deserializeAttachment() || {};
    let message;
    try {
      const text = typeof rawMessage === "string" ? rawMessage : decoder.decode(rawMessage);
      message = JSON.parse(text);
    } catch {
      this.send(socket, { type: "error", message: "잘못된 신호 메시지입니다." });
      return;
    }
    const payload = {
      ...message,
      from: sender.clientId,
      role: sender.role,
      at: nowIso(),
    };
    delete payload.clientId;
    this.broadcast(payload, sender.clientId, message.to || null);
  }

  async webSocketClose(socket) {
    const sender = socket.deserializeAttachment() || {};
    this.broadcast({ type: "peer-left", clientId: sender.clientId, role: sender.role, at: nowIso() }, sender.clientId);
  }

  async webSocketError(socket) {
    const sender = socket.deserializeAttachment() || {};
    this.broadcast({ type: "peer-left", clientId: sender.clientId, role: sender.role, at: nowIso() }, sender.clientId);
    try { socket.close(1011, "WebSocket error"); } catch { /* noop */ }
  }
}


/* ---------- Notifications, AI, and realtime helpers ---------- */

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function broadcastDevice(env, deviceId, payload) {
  if (!env.SIGNALING || !deviceId) return false;
  try {
    const id = env.SIGNALING.idFromName(deviceId);
    const response = await env.SIGNALING.get(id).fetch("https://internal/broadcast", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return response.ok;
  } catch (error) {
    console.warn("realtime broadcast failed", error);
    return false;
  }
}

async function sendWebhook(env, payload) {
  if (!env.NOTIFY_WEBHOOK_URL) return { status: "not_configured" };
  try {
    const response = await fetch(env.NOTIFY_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { status: response.ok ? "sent" : `failed:${response.status}` };
  } catch (error) {
    return { status: `failed:${String(error?.message || error)}` };
  }
}

async function sendEmail(env, { to, subject, text, html, attachments = [] }) {
  const recipient = to || env.ADMIN_EMAIL;
  if (!recipient) return { status: "not_configured" };
  const attempts = [];

  if (env.CLOUDFLARE_ACCOUNT_ID && env.CF_EMAIL_API_TOKEN && env.EMAIL_FROM) {
    try {
      const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/email/sending/send`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.CF_EMAIL_API_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          to: recipient,
          from: env.EMAIL_FROM,
          subject,
          text,
          html,
          ...(attachments.length ? { attachments } : {}),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.success !== false) return { status: "sent:cloudflare", detail: body };
      attempts.push(`cloudflare:${response.status}`);
    } catch (error) {
      attempts.push(`cloudflare:${String(error?.message || error)}`);
    }
  }

  if (env.RESEND_API_KEY && env.EMAIL_FROM) {
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.RESEND_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          to: [recipient],
          from: env.EMAIL_FROM,
          subject,
          text,
          html,
          ...(attachments.length ? { attachments: attachments.map((item) => ({ filename: item.filename, content: item.content })) } : {}),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.id) return { status: "sent:resend", detail: body };
      attempts.push(`resend:${response.status}`);
    } catch (error) {
      attempts.push(`resend:${String(error?.message || error)}`);
    }
  }

  return { status: attempts.length ? `failed:${attempts.join("|")}` : "not_configured" };
}

function dataUrlFromBase64(value, contentType = "image/jpeg") {
  const raw = String(value || "");
  return raw.startsWith("data:") ? raw : `data:${contentType};base64,${raw}`;
}

function extractOpenAIText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text.trim();
  const chunks = [];
  for (const item of payload?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string") chunks.push(content.text);
      if (typeof content?.output_text === "string") chunks.push(content.output_text);
    }
  }
  return chunks.join("\n").trim();
}

async function runOpenAI(env, { systemPrompt, userText, imageDataUrl = null, maxOutputTokens = 2200 }) {
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY 미설정");
  const content = [{ type: "input_text", text: userText }];
  if (imageDataUrl) content.push({ type: "input_image", image_url: imageDataUrl, detail: "high" });
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-5-mini",
      input: [
        { role: "developer", content: [{ type: "input_text", text: systemPrompt }] },
        { role: "user", content },
      ],
      max_output_tokens: maxOutputTokens,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || `OpenAI ${response.status}`);
  const text = extractOpenAIText(payload);
  if (!text) throw new Error("AI 응답이 비어 있습니다.");
  return { provider: "openai", text };
}

async function runWorkersAI(env, { systemPrompt, userText, imageDataUrl = null, maxOutputTokens = 2200 }) {
  if (!env.AI) throw new Error("Workers AI binding 미설정");
  const userContent = imageDataUrl
    ? [
        { type: "text", text: userText },
        { type: "image_url", image_url: { url: imageDataUrl } },
      ]
    : userText;
  const result = await env.AI.run(env.WORKERS_AI_MODEL || "@cf/qwen/qwen3.8-27b", {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    max_tokens: maxOutputTokens,
  });
  const text = String(result?.response || result?.result || result?.text || "").trim();
  if (!text) throw new Error("Workers AI 응답이 비어 있습니다.");
  return { provider: "workers-ai", text };
}

async function runAI(env, options) {
  const errors = [];
  const preference = String(env.AI_PROVIDER || "workers-ai,openai").split(",").map((v) => v.trim());
  for (const provider of preference) {
    try {
      if (provider === "openai") return await runOpenAI(env, options);
      if (provider === "workers-ai") return await runWorkersAI(env, options);
    } catch (error) {
      errors.push(`${provider}: ${String(error?.message || error)}`);
    }
  }
  throw new Error(`AI 분석을 실행할 수 없습니다. ${errors.join(" / ")}`);
}

function riskSeverityFromAnalysis(text) {
  const value = String(text || "");
  if (/R\s*=\s*[789]|우선 확인이 필요한 높은 위험|작업을 일시 중지/i.test(value)) return "high";
  if (/R\s*=\s*[456]|개선이 필요한 위험/i.test(value)) return "medium";
  return "low";
}

const TBM_SYSTEM_PROMPT = `당신은 제조업 현장의 TBM 안전소통을 지원하는 산업안전 관리자입니다.
입력된 D-안전회의 메일에서 확인되는 내용만 사용하여 다음 순서로 한국어로 정리합니다.
1. 작업일자와 작업명
2. 작업 장소와 작업 인원(메일에 있는 경우만)
3. 핵심 작업내용
4. 주요 위험요인
5. 필수 안전조치
6. TBM에서 반드시 전달할 5가지 요점
7. 작업자에게 질문할 확인사항 3개
8. 추가 확인이 필요한 사항
메일에 없는 내용을 사실처럼 만들지 말고, 불명확한 내용은 '추가 확인 필요'라고 표시합니다.`;

async function createTbmSession(env, body) {
  const subject = String(body.subject || "D-안전회의").trim();
  const emailBody = String(body.emailBody || "").trim();
  if (emailBody.length < 10) throw new Error("메일 본문을 10자 이상 입력해주세요.");
  const lessons = await env.DB.prepare("SELECT opinion,ai_recommendation FROM tbm_feedback ORDER BY created_at DESC LIMIT 20").all();
  const lessonText = (lessons.results || []).map((row, index) => `${index + 1}. 의견: ${row.opinion}\n보완: ${row.ai_recommendation}`).join("\n");
  const ai = await runAI(env, {
    systemPrompt: TBM_SYSTEM_PROMPT,
    userText: `메일 제목: ${subject}\n작업일자: ${String(body.workDate || "미지정")}\n\n메일 본문:\n${emailBody}\n\n과거 작업자 의견에서 축적된 참고사항:\n${lessonText || "없음"}`,
    maxOutputTokens: 1800,
  });
  const id = randomId("tbm");
  const now = nowIso();
  await env.DB.prepare("UPDATE tbm_sessions SET active=0,updated_at=? WHERE active=1").bind(now).run();
  await env.DB.prepare(`INSERT INTO tbm_sessions (id,subject,work_date,source_email,email_body,summary_text,manager_email,status,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'진행',1,?,?)`)
    .bind(id, subject, String(body.workDate || ""), String(body.sourceEmail || ""), emailBody, ai.text, String(body.managerEmail || env.ADMIN_EMAIL || ""), now, now).run();
  return { id, subject, workDate: String(body.workDate || ""), summaryText: ai.text, provider: ai.provider, active: true, createdAt: now };
}

/* ---------- Data mapping ---------- */

function mapDevice(row) {
  const lastSeenMs = row.last_seen ? Date.parse(row.last_seen) : 0;
  const recent = lastSeenMs > Date.now() - 90000;
  const status = row.status === "offline" ? "offline" : recent ? "online" : "offline";
  return {
    id: row.id,
    name: row.name,
    site: row.site,
    area: row.area,
    cameraLabel: row.camera_label,
    status,
    agentVersion: row.agent_version,
    lastSeen: row.last_seen,
    fps: Number(row.fps || 0),
    cpu: Number(row.cpu || 0),
    memory: Number(row.memory || 0),
    peopleCount: Number(row.people_count || 0),
    currentRisk: row.current_risk || "정상",
    previewUrl: row.preview_key ? `/media/${encodeURIComponent(row.preview_key)}` : null,
    config: normalizeConfig(safeJsonParse(row.config_json, defaultConfig())),
  };
}

function mapEvent(row) {
  return {
    id: row.id,
    deviceId: row.device_id,
    deviceName: row.device_name || row.device_id,
    site: row.site || "",
    type: row.type,
    category: row.category,
    severity: row.severity,
    message: row.message,
    occurredAt: row.occurred_at,
    acknowledged: Boolean(row.acknowledged),
    status: row.status,
    snapshotUrl: row.snapshot_key ? `/media/${encodeURIComponent(row.snapshot_key)}` : null,
    metadata: safeJsonParse(row.metadata_json, {}),
  };
}


function mapWorkStop(row) {
  return {
    id: row.id,
    deviceId: row.device_id,
    deviceName: row.device_name || row.device_id,
    site: row.site || "",
    area: row.area || "",
    requesterName: row.requester_name,
    requesterContact: row.requester_contact,
    reason: row.reason,
    status: row.status,
    requestedAt: row.requested_at,
    acknowledgedAt: row.acknowledged_at,
    resolvedAt: row.resolved_at,
    snapshotUrl: row.snapshot_key ? `/media/${encodeURIComponent(row.snapshot_key)}` : null,
    emailStatus: row.email_status,
    metadata: safeJsonParse(row.metadata_json, {}),
  };
}

function mapTbmSession(row) {
  return {
    id: row.id,
    subject: row.subject,
    workDate: row.work_date,
    sourceEmail: row.source_email,
    emailBody: row.email_body,
    summaryText: row.summary_text,
    managerEmail: row.manager_email,
    status: row.status,
    active: Boolean(row.active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getDevices(env) {
  const result = await env.DB.prepare("SELECT * FROM devices ORDER BY name ASC").all();
  return (result.results || []).map(mapDevice);
}

async function getEvents(env, url) {
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 100), 1), 500);
  const deviceId = url.searchParams.get("deviceId");
  const category = url.searchParams.get("category");
  const severity = url.searchParams.get("severity");
  let sql = `SELECT e.*, d.name AS device_name, d.site AS site FROM events e LEFT JOIN devices d ON d.id=e.device_id WHERE 1=1`;
  const values = [];
  if (deviceId) { sql += " AND e.device_id=?"; values.push(deviceId); }
  if (category) { sql += " AND e.category=?"; values.push(category); }
  if (severity) { sql += " AND e.severity=?"; values.push(severity); }
  sql += " ORDER BY e.occurred_at DESC LIMIT ?";
  values.push(limit);
  const result = await env.DB.prepare(sql).bind(...values).all();
  return (result.results || []).map(mapEvent);
}

async function getSummary(env) {
  const devices = await getDevices(env);
  const eventsResult = await env.DB.prepare("SELECT * FROM events WHERE occurred_at >= ? ORDER BY occurred_at DESC").bind(new Date(Date.now() - 86400000).toISOString()).all();
  const events = eventsResult.results || [];
  const categoryCounts = {};
  for (const event of events) categoryCounts[event.category] = (categoryCounts[event.category] || 0) + 1;
  return {
    online: devices.filter((device) => device.status === "online").length,
    totalDevices: devices.length,
    people: devices.reduce((sum, device) => sum + device.peopleCount, 0),
    todayEvents: events.length,
    highRisk: events.filter((event) => ["high", "critical"].includes(event.severity)).length,
    unacknowledged: events.filter((event) => !event.acknowledged).length,
    activeStops: Number((await env.DB.prepare("SELECT COUNT(*) AS count FROM work_stop_requests WHERE status NOT IN ('해제','종료')").first())?.count || 0),
    categoryCounts,
    generatedAt: nowIso(),
  };
}

function exactArrayBuffer(value) {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  return new Uint8Array(value).buffer;
}

async function putImage(env, key, bytes, contentType = "image/jpeg") {
  const buffer = exactArrayBuffer(bytes);
  if (!buffer.byteLength || buffer.byteLength > 1_500_000) return null;
  await env.DB.prepare(`INSERT INTO media (key, content_type, bytes, byte_length, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET content_type=excluded.content_type, bytes=excluded.bytes, byte_length=excluded.byte_length, updated_at=excluded.updated_at`).bind(key, contentType, buffer, buffer.byteLength, nowIso()).run();
  return key;
}

function base64ToBytes(base64) {
  const clean = base64.includes(",") ? base64.split(",").pop() : base64;
  const binary = atob(clean || "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/* ---------- API ---------- */

async function handleAuth(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/api/auth/login" && request.method === "POST") {
    const body = await readJson(request);
    const role = body.role === "user" ? "user" : "admin";
    const expected = role === "admin" ? (env.ADMIN_PIN || "2468") : (env.USER_PIN || "1357");
    if (String(body.pin || "") !== String(expected)) return error("비밀번호가 올바르지 않습니다.", 401);
    const { token, payload } = await createSession(role, env);
    return json({ ok: true, data: { role, expiresAt: new Date(payload.exp).toISOString() } }, 200, { "set-cookie": sessionCookie(token, request) });
  }
  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    return json({ ok: true }, 200, { "set-cookie": sessionCookie("", request, 0) });
  }
  if (url.pathname === "/api/auth/me" && request.method === "GET") {
    const session = await readSession(request, env);
    if (!session) return error("로그인이 필요합니다.", 401);
    return json({ ok: true, data: { role: session.role, expiresAt: new Date(session.exp).toISOString() } });
  }
  return null;
}

async function handleRealtime(request, env) {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/realtime\/([^/]+)$/);
  if (!match) return null;
  const role = url.searchParams.get("role");
  const auth = await requireSession(request, env, role === "admin" ? "admin" : null);
  if (auth.response) return auth.response;
  if (role === "guard" && !["user", "admin"].includes(auth.session.role)) return error("현장 지킴이 권한이 없습니다.", 403);
  if (!env.SIGNALING) return error("Durable Object SIGNALING 바인딩이 없습니다.", 500);
  const deviceId = decodeURIComponent(match[1]);
  const id = env.SIGNALING.idFromName(deviceId);
  return env.SIGNALING.get(id).fetch(request);
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  const authResponse = await handleAuth(request, env);
  if (authResponse) return authResponse;

  if (path === "/api/health" && method === "GET") {
    return json({ ok: true, data: { ok: true, service: env.APP_NAME || "스마트 안전지킴이", company: env.COMPANY_NAME || "POSCO Future M", time: nowIso(), realtime: Boolean(env.SIGNALING), browserEdition: true, version: "4.0.0" } });
  }

  const realtimeResponse = await handleRealtime(request, env);
  if (realtimeResponse) return realtimeResponse;

  if (path === "/api/tbm/inbound-email" && method === "POST") {
    if (!env.TBM_INBOUND_TOKEN || request.headers.get("x-tbm-token") !== env.TBM_INBOUND_TOKEN) return error("TBM 수신 토큰이 올바르지 않습니다.", 401);
    await ensureSchema(env);
    const body = await readJson(request);
    try {
      const session = await createTbmSession(env, body);
      const email = body.sendEmail === false ? { status: "skipped" } : await sendEmail(env, {
        to: body.managerEmail || env.ADMIN_EMAIL,
        subject: `[TBM 안전소통] ${session.subject}`,
        text: session.summaryText,
        html: `<h2>${escapeHtml(session.subject)}</h2><pre style="white-space:pre-wrap;font-family:sans-serif">${escapeHtml(session.summaryText)}</pre>`,
      });
      return json({ ok: true, data: { ...session, emailStatus: email.status } }, 201);
    } catch (err) { return error(String(err?.message || err), 400); }
  }

  const auth = await requireSession(request, env);
  if (auth.response) return auth.response;
  const isAdmin = auth.session.role === "admin";

  await ensureSchema(env);

  if (path === "/api/ice" && method === "GET") {
    let extra = [];
    try { extra = env.TURN_ICE_SERVERS ? JSON.parse(env.TURN_ICE_SERVERS) : []; } catch { extra = []; }
    return json({ ok: true, data: { iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }, ...(Array.isArray(extra) ? extra : [])] } });
  }

  const adminOnly = path.startsWith("/api/dashboard/") || path === "/api/devices" || path === "/api/events" || path.startsWith("/api/reports/") || path.startsWith("/api/admin/") || path.startsWith("/api/demo/") || (path.startsWith("/api/devices/") && method !== "GET") || path.match(/^\/api\/events\/[^/]+\/ack$/) || (path.startsWith("/api/work-stop") && method === "GET") || path.match(/^\/api\/work-stop\/[^/]+\/status$/) || path === "/api/tbm/sessions";
  if (adminOnly && !isAdmin) return error("관리자 권한이 필요합니다.", 403);

  if (path === "/api/dashboard/summary" && method === "GET") return json({ ok: true, data: await getSummary(env) });
  if (path === "/api/devices" && method === "GET") return json({ ok: true, data: await getDevices(env) });
  if (path === "/api/events" && method === "GET") return json({ ok: true, data: await getEvents(env, url) });

  if (path === "/api/work-stop" && method === "GET") {
    const result = await env.DB.prepare(`SELECT w.*,d.name AS device_name,d.site,d.area FROM work_stop_requests w LEFT JOIN devices d ON d.id=w.device_id ORDER BY w.requested_at DESC LIMIT 200`).all();
    return json({ ok: true, data: (result.results || []).map(mapWorkStop) });
  }

  if (path === "/api/work-stop" && method === "POST") {
    const body = await readJson(request);
    const deviceId = String(body.deviceId || "").trim();
    const reason = String(body.reason || "").trim();
    if (!deviceId) return error("deviceId가 필요합니다.");
    if (reason.length < 5) return error("작업중지 사유를 5자 이상 입력해주세요.");
    const id = randomId("stop");
    const now = nowIso();
    let snapshotKey = null;
    let attachment = [];
    if (body.snapshotBase64) {
      const bytes = base64ToBytes(String(body.snapshotBase64));
      if (bytes.byteLength <= 1200000) {
        snapshotKey = await putImage(env, `work-stop/${deviceId}/${id}.jpg`, bytes, "image/jpeg");
        attachment = [{ content: String(body.snapshotBase64).split(",").pop(), filename: `${id}.jpg`, type: "image/jpeg", disposition: "attachment" }];
      }
    }
    const requesterName = String(body.requesterName || "현장 작업자");
    const requesterContact = String(body.requesterContact || "");
    const metadata = { category: body.category || "현장 위험", autoCall: body.autoCall !== false };
    await env.DB.prepare(`INSERT INTO work_stop_requests (id,device_id,requester_name,requester_contact,reason,status,requested_at,snapshot_key,email_status,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,'요청',?,?,'',?,?,?)`)
      .bind(id, deviceId, requesterName, requesterContact, reason, now, snapshotKey, JSON.stringify(metadata), now, now).run();
    await env.DB.prepare(`INSERT INTO events (id,device_id,type,category,severity,message,occurred_at,acknowledged,status,snapshot_key,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,0,'즉시 확인',?,?,?)`)
      .bind(randomId("evt"), deviceId, "STOP_WORK_REQUEST", "작업중지권", "critical", `작업중지권 행사: ${reason}`, now, snapshotKey, JSON.stringify({ workStopId: id, requesterName, requesterContact }), now).run();
    await env.DB.prepare("UPDATE devices SET current_risk='작업중지',last_seen=?,status='online',updated_at=? WHERE id=?").bind(now, now, deviceId).run();
    const device = await env.DB.prepare("SELECT name,site,area FROM devices WHERE id=?").bind(deviceId).first();
    const subject = `[긴급] 작업중지권 행사 - ${device?.name || deviceId}`;
    const text = `작업중지권이 행사되었습니다.\n장치: ${device?.name || deviceId}\n사업장: ${device?.site || ""} ${device?.area || ""}\n요청자: ${requesterName}\n사유: ${reason}\n시간: ${now}`;
    const email = await sendEmail(env, { to: body.notifyEmail || env.ADMIN_EMAIL, subject, text, html: `<h2 style="color:#c62828">작업중지권 행사</h2><p><b>장치:</b> ${escapeHtml(device?.name || deviceId)}</p><p><b>사업장:</b> ${escapeHtml(`${device?.site || ""} ${device?.area || ""}`)}</p><p><b>요청자:</b> ${escapeHtml(requesterName)}</p><p><b>사유:</b> ${escapeHtml(reason)}</p><p><b>시간:</b> ${escapeHtml(now)}</p>`, attachments: attachment });
    const webhook = await sendWebhook(env, { type: "STOP_WORK_REQUEST", id, deviceId, device, requesterName, requesterContact, reason, requestedAt: now });
    await env.DB.prepare("UPDATE work_stop_requests SET email_status=?,updated_at=? WHERE id=?").bind(`${email.status};webhook:${webhook.status}`, nowIso(), id).run();
    await broadcastDevice(env, deviceId, { type: "stop-work-request", id, deviceId, requesterName, requesterContact, reason, requestedAt: now, device });
    return json({ ok: true, data: { id, status: "요청", emailStatus: email.status, webhookStatus: webhook.status } }, 201);
  }

  const workStopStatusMatch = path.match(/^\/api\/work-stop\/([^/]+)\/status$/);
  if (workStopStatusMatch && method === "POST") {
    const body = await readJson(request);
    const id = decodeURIComponent(workStopStatusMatch[1]);
    const allowed = ["접수", "작업중지 확인", "조치 중", "해제", "종료"];
    const status = allowed.includes(body.status) ? body.status : "접수";
    const row = await env.DB.prepare(`SELECT w.*,d.name AS device_name,d.site,d.area FROM work_stop_requests w LEFT JOIN devices d ON d.id=w.device_id WHERE w.id=?`).bind(id).first();
    if (!row) return error("작업중지 요청을 찾을 수 없습니다.", 404);
    const now = nowIso();
    await env.DB.prepare("UPDATE work_stop_requests SET status=?,acknowledged_at=COALESCE(acknowledged_at,?),resolved_at=CASE WHEN ? IN ('해제','종료') THEN ? ELSE resolved_at END,updated_at=? WHERE id=?")
      .bind(status, now, status, now, now, id).run();
    await env.DB.prepare("UPDATE events SET acknowledged=?,status=? WHERE type='STOP_WORK_REQUEST' AND json_extract(metadata_json,'$.workStopId')=?")
      .bind(["해제", "종료"].includes(status) ? 1 : 0, status, id).run();
    if (["해제", "종료"].includes(status)) await env.DB.prepare("UPDATE devices SET current_risk='정상',updated_at=? WHERE id=?").bind(now, row.device_id).run();
    await broadcastDevice(env, row.device_id, { type: "stop-work-status", id, status, note: String(body.note || ""), at: now });
    const subject = `[작업중지권 ${status}] ${row.device_name || row.device_id}`;
    await sendEmail(env, { to: body.notifyEmail || env.ADMIN_EMAIL, subject, text: `작업중지권 상태가 ${status}(으)로 변경되었습니다.\n사유: ${row.reason}\n관리자 메모: ${String(body.note || "")}`, html: `<h2>작업중지권 상태 변경</h2><p><b>상태:</b> ${escapeHtml(status)}</p><p><b>사유:</b> ${escapeHtml(row.reason)}</p><p><b>관리자 메모:</b> ${escapeHtml(body.note || "")}</p>` });
    return json({ ok: true, data: { id, status } });
  }

  if (path === "/api/ai/photo-analysis" && method === "POST") {
    const body = await readJson(request);
    const deviceId = String(body.deviceId || "").trim();
    const imageBase64 = String(body.imageBase64 || "");
    if (!deviceId || imageBase64.length < 100) return error("장치와 캡처 이미지가 필요합니다.");
    const id = randomId("analysis");
    const bytes = base64ToBytes(imageBase64);
    if (bytes.byteLength > 1500000) return error("분석 이미지는 1.5MB 이하여야 합니다.", 413);
    const imageKey = await putImage(env, `analysis/${deviceId}/${id}.jpg`, bytes, "image/jpeg");
    let ai;
    try {
      ai = await runAI(env, {
        systemPrompt: SAFETY_PHOTO_PROMPT,
        userText: "첨부된 현장 사진을 고정된 절차와 출력 형식에 따라 분석하세요. 사진에서 객관적으로 확인할 수 없는 내용은 추정하지 마세요.",
        imageDataUrl: dataUrlFromBase64(imageBase64),
        maxOutputTokens: 2600,
      });
    } catch (err) {
      return error(`사진 AI 분석 실패: ${String(err?.message || err)}`, 503);
    }
    const severity = riskSeverityFromAnalysis(ai.text);
    const now = nowIso();
    const device = await env.DB.prepare("SELECT name,site,area FROM devices WHERE id=?").bind(deviceId).first();
    const email = body.sendEmail === false ? { status: "skipped" } : await sendEmail(env, {
      to: body.notifyEmail || env.ADMIN_EMAIL,
      subject: `[AI 현장사진 분석] ${device?.name || deviceId}`,
      text: ai.text,
      html: `<h2>AI 현장사진 위험요인 분석</h2><p><b>장치:</b> ${escapeHtml(device?.name || deviceId)}</p><pre style="white-space:pre-wrap;font-family:sans-serif">${escapeHtml(ai.text)}</pre>`,
      attachments: [{ content: imageBase64.split(",").pop(), filename: `${id}.jpg`, type: "image/jpeg", disposition: "attachment" }],
    });
    await env.DB.prepare(`INSERT INTO photo_analyses (id,device_id,image_key,provider,analysis_text,severity,email_status,created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(id, deviceId, imageKey, ai.provider, ai.text, severity, email.status, now).run();
    await env.DB.prepare(`INSERT INTO events (id,device_id,type,category,severity,message,occurred_at,acknowledged,status,snapshot_key,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,0,'확인 필요',?,?,?)`)
      .bind(randomId("evt"), deviceId, "PHOTO_AI_ANALYSIS", "AI 사진분석", severity, "현장 사진 AI 위험요인 분석이 완료되었습니다.", now, imageKey, JSON.stringify({ analysisId: id, provider: ai.provider, analysisText: ai.text }), now).run();
    await broadcastDevice(env, deviceId, { type: "photo-analysis-ready", id, severity, analysisText: ai.text, imageUrl: imageKey ? `/media/${encodeURIComponent(imageKey)}` : null, at: now });
    return json({ ok: true, data: { id, provider: ai.provider, analysisText: ai.text, severity, imageUrl: imageKey ? `/media/${encodeURIComponent(imageKey)}` : null, emailStatus: email.status } }, 201);
  }

  if (path === "/api/tbm/sessions" && method === "GET") {
    const result = await env.DB.prepare("SELECT * FROM tbm_sessions ORDER BY created_at DESC LIMIT 100").all();
    return json({ ok: true, data: (result.results || []).map(mapTbmSession) });
  }

  if (path === "/api/tbm/active" && method === "GET") {
    const row = await env.DB.prepare("SELECT * FROM tbm_sessions WHERE active=1 ORDER BY created_at DESC LIMIT 1").first();
    if (!row) return json({ ok: true, data: null });
    const feedback = await env.DB.prepare("SELECT * FROM tbm_feedback WHERE session_id=? ORDER BY created_at DESC LIMIT 100").bind(row.id).all();
    return json({ ok: true, data: { ...mapTbmSession(row), feedback: feedback.results || [] } });
  }

  if (path === "/api/tbm/sessions" && method === "POST") {
    const body = await readJson(request);
    try {
      const session = await createTbmSession(env, body);
      const email = body.sendEmail === false ? { status: "skipped" } : await sendEmail(env, { to: body.managerEmail || env.ADMIN_EMAIL, subject: `[TBM 안전소통] ${session.subject}`, text: session.summaryText, html: `<h2>${escapeHtml(session.subject)}</h2><pre style="white-space:pre-wrap;font-family:sans-serif">${escapeHtml(session.summaryText)}</pre>` });
      return json({ ok: true, data: { ...session, emailStatus: email.status } }, 201);
    } catch (err) { return error(String(err?.message || err), 400); }
  }

  if (path === "/api/tbm/feedback" && method === "POST") {
    const body = await readJson(request);
    const sessionId = String(body.sessionId || "");
    const opinion = String(body.opinion || "").trim();
    if (!sessionId || opinion.length < 3) return error("TBM 세션과 작업자 의견을 입력해주세요.");
    const session = await env.DB.prepare("SELECT * FROM tbm_sessions WHERE id=?").bind(sessionId).first();
    if (!session) return error("TBM 세션을 찾을 수 없습니다.", 404);
    let ai;
    try {
      ai = await runAI(env, {
        systemPrompt: "당신은 산업안전 관리자입니다. 작업자의 현장 의견을 객관적으로 검토하여 추가 위험요인, 근거, 보완 안전조치, 담당자 확인사항을 한국어로 간결하게 작성합니다. 의견에 없는 사실은 만들지 않습니다.",
        userText: `기존 TBM 요약:\n${session.summary_text}\n\n작업자 의견:\n${opinion}`,
        maxOutputTokens: 1000,
      });
    } catch (err) { return error(`의견 AI 검토 실패: ${String(err?.message || err)}`, 503); }
    const id = randomId("feedback");
    const now = nowIso();
    const email = await sendEmail(env, { to: session.manager_email || env.ADMIN_EMAIL, subject: `[TBM 작업자 의견] ${session.subject}`, text: `작업자 의견:\n${opinion}\n\nAI 보완 검토:\n${ai.text}`, html: `<h2>TBM 작업자 의견</h2><p><b>작업자:</b> ${escapeHtml(body.workerName || "익명")}</p><p><b>의견:</b></p><pre style="white-space:pre-wrap;font-family:sans-serif">${escapeHtml(opinion)}</pre><p><b>AI 보완 검토:</b></p><pre style="white-space:pre-wrap;font-family:sans-serif">${escapeHtml(ai.text)}</pre>` });
    await env.DB.prepare(`INSERT INTO tbm_feedback (id,session_id,device_id,worker_name,opinion,ai_recommendation,email_status,created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(id, sessionId, String(body.deviceId || ""), String(body.workerName || "익명"), opinion, ai.text, email.status, now).run();
    const reflectedSummary = `${session.summary_text}\n\n[작업자 의견 반영 ${now.slice(0, 16).replace("T", " ")}]\n- 의견: ${opinion}\n- AI 보완: ${ai.text}`;
    await env.DB.prepare("UPDATE tbm_sessions SET summary_text=?,updated_at=? WHERE id=?")
      .bind(reflectedSummary, now, sessionId).run();
    return json({ ok: true, data: { id, aiRecommendation: ai.text, updatedSummary: reflectedSummary, emailStatus: email.status } }, 201);
  }

  if (path === "/api/ppe-feedback" && method === "POST") {
    const body = await readJson(request);
    const deviceId = String(body.deviceId || "").trim();
    if (!deviceId) return error("deviceId가 필요합니다.");
    const id = randomId("ppefb");
    const capturedAt = String(body.capturedAt || nowIso());
    let imageKey = null;
    if (body.snapshotBase64) {
      const bytes = base64ToBytes(String(body.snapshotBase64));
      if (bytes.byteLength > 1400000) return error("학습 이미지는 1.4MB 이하여야 합니다.", 413);
      imageKey = await putImage(env, `training/ppe/${deviceId}/${id}.jpg`, bytes, "image/jpeg");
    }
    await env.DB.prepare(`INSERT INTO ppe_feedback (id,device_id,captured_at,predicted_json,actual_json,image_key,model_version,reviewed,created_at) VALUES (?,?,?,?,?,?,?,1,?)`)
      .bind(id, deviceId, capturedAt, JSON.stringify(body.predicted || {}), JSON.stringify(body.actual || {}), imageKey, String(body.modelVersion || ""), nowIso()).run();
    return json({ ok: true, data: { id, imageUrl: imageKey ? `/media/${encodeURIComponent(imageKey)}` : null } }, 201);
  }

  if (path === "/api/ppe-feedback" && method === "GET") {
    if (!isAdmin) return error("관리자 권한이 필요합니다.", 403);
    const rows = await env.DB.prepare(`SELECT id,device_id,captured_at,predicted_json,actual_json,image_key,model_version,created_at FROM ppe_feedback ORDER BY created_at DESC LIMIT 300`).all();
    return json({ ok: true, data: (rows.results || []).map((row) => ({ ...row, predicted: safeJsonParse(row.predicted_json, {}), actual: safeJsonParse(row.actual_json, {}), imageUrl: row.image_key ? `/media/${encodeURIComponent(row.image_key)}` : null })) });
  }

  if (path === "/api/reports/daily" && method === "GET") {
    const days = Math.min(Math.max(Number(url.searchParams.get("days") || 7), 1), 31);
    const result = await env.DB.prepare(`SELECT substr(occurred_at,1,10) AS day, category, severity, COUNT(*) AS count FROM events WHERE occurred_at >= ? GROUP BY day, category, severity ORDER BY day ASC`).bind(new Date(Date.now() - days * 86400000).toISOString()).all();
    return json({ ok: true, data: result.results || [] });
  }

  if (path === "/api/agents/register" && method === "POST") {
    const body = await readJson(request);
    const id = String(body.deviceId || "").trim();
    if (!id) return error("deviceId가 필요합니다.");
    const now = nowIso();
    const requestedConfig = normalizeConfig(body.config && typeof body.config === "object" ? body.config : defaultConfig());
    const current = await env.DB.prepare("SELECT config_json FROM devices WHERE id=?").bind(id).first();
    const config = current?.config_json ? normalizeConfig(safeJsonParse(current.config_json, requestedConfig)) : requestedConfig;
    await env.DB.prepare(`INSERT INTO devices (id,name,site,area,camera_label,status,agent_version,last_seen,fps,cpu,memory,people_count,current_risk,preview_key,config_json,created_at,updated_at) VALUES (?,?,?,?,?,'online',?,?,0,0,0,0,'정상',NULL,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,site=excluded.site,area=excluded.area,camera_label=excluded.camera_label,status='online',agent_version=excluded.agent_version,last_seen=excluded.last_seen,config_json=excluded.config_json,updated_at=excluded.updated_at`).bind(id, String(body.name || id), String(body.site || "미지정 사업장"), String(body.area || "미지정 구역"), String(body.cameraLabel || "브라우저 카메라"), String(body.agentVersion || "browser-webrtc-4.4-learning"), now, JSON.stringify(config), now, now).run();
    const device = await env.DB.prepare("SELECT * FROM devices WHERE id=?").bind(id).first();
    return json({ ok: true, data: mapDevice(device) }, 201);
  }

  if (path === "/api/agents/heartbeat" && method === "POST") {
    const body = await readJson(request);
    const id = String(body.deviceId || "").trim();
    if (!id) return error("deviceId가 필요합니다.");
    const now = nowIso();
    await env.DB.prepare(`UPDATE devices SET status='online',last_seen=?,fps=?,cpu=?,memory=?,people_count=?,current_risk=?,agent_version=COALESCE(?,agent_version),updated_at=? WHERE id=?`).bind(now, Number(body.fps || 0), Number(body.cpu || 0), Number(body.memory || 0), Number(body.peopleCount || 0), String(body.currentRisk || "정상"), body.agentVersion ? String(body.agentVersion) : null, now, id).run();
    return json({ ok: true, serverTime: now });
  }

  if (path === "/api/agents/offline" && method === "POST") {
    const body = await readJson(request).catch(() => ({}));
    const id = String(body.deviceId || "").trim();
    if (!id) return error("deviceId가 필요합니다.");
    await env.DB.prepare("UPDATE devices SET status='offline',people_count=0,current_risk='연결 종료',updated_at=? WHERE id=?").bind(nowIso(), id).run();
    return json({ ok: true });
  }

  const previewMatch = path.match(/^\/api\/agents\/preview\/([^/]+)$/);
  if (previewMatch && method === "POST") {
    const deviceId = decodeURIComponent(previewMatch[1]);
    const bytes = await request.arrayBuffer();
    if (!bytes.byteLength) return error("이미지 본문이 비어 있습니다.");
    if (bytes.byteLength > 700000) return error("프리뷰 이미지는 700KB 이하여야 합니다.", 413);
    const key = `previews/${deviceId}/latest.jpg`;
    const stored = await putImage(env, key, bytes, request.headers.get("content-type") || "image/jpeg");
    const now = nowIso();
    await env.DB.prepare("UPDATE devices SET preview_key=?,last_seen=?,status='online',updated_at=? WHERE id=?").bind(stored, now, now, deviceId).run();
    return json({ ok: true, previewUrl: stored ? `/media/${encodeURIComponent(stored)}` : null });
  }

  if (path === "/api/agents/event" && method === "POST") {
    const body = await readJson(request);
    const deviceId = String(body.deviceId || "").trim();
    if (!deviceId) return error("deviceId가 필요합니다.");
    const eventId = String(body.id || randomId("evt"));
    let snapshotKey = null;
    if (body.snapshotBase64) {
      const bytes = base64ToBytes(String(body.snapshotBase64));
      if (bytes.byteLength <= 1200000) snapshotKey = await putImage(env, `events/${deviceId}/${eventId}.jpg`, bytes, "image/jpeg");
    }
    const occurredAt = String(body.occurredAt || nowIso());
    await env.DB.prepare(`INSERT INTO events (id,device_id,type,category,severity,message,occurred_at,acknowledged,status,snapshot_key,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,0,'확인 필요',?,?,?)`).bind(eventId, deviceId, String(body.type || "UNKNOWN"), String(body.category || "기타"), String(body.severity || "medium"), String(body.message || "안전 이벤트가 발생했습니다."), occurredAt, snapshotKey, JSON.stringify(body.metadata || {}), nowIso()).run();
    const now = nowIso();
    await env.DB.prepare("UPDATE devices SET current_risk=?,last_seen=?,status='online',updated_at=? WHERE id=?").bind(["critical", "high"].includes(body.severity) ? "위험" : "주의", now, now, deviceId).run();
    return json({ ok: true, id: eventId }, 201);
  }

  const configMatch = path.match(/^\/api\/devices\/([^/]+)\/config$/);
  if (configMatch && method === "GET") {
    const deviceId = decodeURIComponent(configMatch[1]);
    const row = await env.DB.prepare("SELECT config_json FROM devices WHERE id=?").bind(deviceId).first();
    if (!row) return error("장치를 찾을 수 없습니다.", 404);
    return json({ ok: true, data: normalizeConfig(safeJsonParse(row.config_json, defaultConfig())) });
  }
  if (configMatch && method === "PUT") {
    if (!isAdmin) return error("관리자 권한이 필요합니다.", 403);
    const deviceId = decodeURIComponent(configMatch[1]);
    const body = await readJson(request);
    const config = normalizeConfig(body.config && typeof body.config === "object" ? body.config : body);
    const result = await env.DB.prepare("UPDATE devices SET config_json=?,updated_at=? WHERE id=?").bind(JSON.stringify(config), nowIso(), deviceId).run();
    if (!result.meta?.changes) return error("장치를 찾을 수 없습니다.", 404);
    return json({ ok: true, data: config });
  }

  const ackMatch = path.match(/^\/api\/events\/([^/]+)\/ack$/);
  if (ackMatch && method === "POST") {
    const body = await readJson(request).catch(() => ({}));
    const result = await env.DB.prepare("UPDATE events SET acknowledged=1,status=? WHERE id=?").bind(String(body.status || "확인 완료"), decodeURIComponent(ackMatch[1])).run();
    if (!result.meta?.changes) return error("이벤트를 찾을 수 없습니다.", 404);
    return json({ ok: true });
  }

  const deleteDeviceMatch = path.match(/^\/api\/devices\/([^/]+)$/);
  if (deleteDeviceMatch && method === "DELETE") {
    const deviceId = decodeURIComponent(deleteDeviceMatch[1]);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM events WHERE device_id=?").bind(deviceId),
      env.DB.prepare("DELETE FROM media WHERE key LIKE ? OR key LIKE ?").bind(`previews/${deviceId}/%`, `events/${deviceId}/%`),
      env.DB.prepare("DELETE FROM devices WHERE id=?").bind(deviceId),
    ]);
    return json({ ok: true });
  }

  if (path === "/api/demo/simulate" && method === "POST") {
    const body = await readJson(request).catch(() => ({}));
    const devices = await getDevices(env);
    if (!devices.length) return error("시뮬레이션할 장치가 없습니다.");
    const device = devices.find((item) => item.id === body.deviceId) || devices[0];
    const samples = [
      ["DANGER_ZONE_ENTRY", "위험구역", "high", "출입 제한 구역에 작업자가 진입했습니다."],
      ["HELMET_NOT_DETECTED", "보호구", "high", "안전모 미착용 의심 상황이 감지되었습니다."],
      ["FORKLIFT_APPROACH", "중장비", "high", "지게차가 작업자 통행구역에 접근했습니다."],
      ["FALL_CANDIDATE", "불안전 행동", "critical", "넘어짐 의심 상황이 감지되었습니다."],
    ];
    const selected = samples[Math.floor(Math.random() * samples.length)];
    const id = randomId("evt");
    const now = nowIso();
    await env.DB.prepare(`INSERT INTO events (id,device_id,type,category,severity,message,occurred_at,acknowledged,status,snapshot_key,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,0,'확인 필요',NULL,'{"simulated":true}',?)`).bind(id, device.id, selected[0], selected[1], selected[2], selected[3], now, now).run();
    return json({ ok: true, id });
  }

  return error("API 경로를 찾을 수 없습니다.", 404);
}

async function handleMedia(request, env) {
  const auth = await requireSession(request, env);
  if (auth.response) return auth.response;
  await ensureSchema(env);
  const url = new URL(request.url);
  const key = decodeURIComponent(url.pathname.replace(/^\/media\//, ""));
  if (!key) return error("미디어 키가 없습니다.", 404);
  const row = await env.DB.prepare("SELECT content_type,bytes,byte_length,updated_at FROM media WHERE key=?").bind(key).first();
  if (!row) return error("이미지를 찾을 수 없습니다.", 404);
  const body = new Uint8Array(row.bytes || []);
  return new Response(body, { headers: { "content-type": row.content_type || "image/jpeg", "content-length": String(row.byte_length || body.byteLength), "cache-control": "no-store", "x-media-storage": "d1" } });
}

async function handleModel(request, env, ctx) {
  const modelUrl = env.PPE_MODEL_URL || "https://huggingface.co/ayushgupta7777/safetyvision-yolov8/resolve/main/v2/best_640.onnx";
  const cache = caches.default;
  const cacheKey = new Request(new URL("/models/ppe.onnx", request.url), { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;
  const upstream = await fetch(modelUrl, { redirect: "follow", headers: { "user-agent": "POSCO-FutureM-Smart-Safety-Guardian/4.0" } });
  if (!upstream.ok) return error("보호구 모델을 불러오지 못했습니다.", 502, `upstream ${upstream.status}`);
  const headers = new Headers(upstream.headers);
  headers.set("content-type", "application/octet-stream");
  headers.set("cache-control", "public, max-age=86400, s-maxage=604800");
  headers.set("content-disposition", "inline; filename=ppe.onnx");
  headers.delete("set-cookie");
  const response = new Response(upstream.body, { status: 200, headers });
  ctx.waitUntil(cache.put(cacheKey, response.clone()).catch(() => {}));
  return response;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS", "access-control-allow-headers": "content-type,authorization", "access-control-allow-credentials": "true" } });
    try {
      if (url.pathname === "/models/ppe.onnx") return await handleModel(request, env, ctx);
      if (url.pathname.startsWith("/api/")) return await handleApi(request, env);
      if (url.pathname.startsWith("/media/")) return await handleMedia(request, env);
      const assetResponse = await env.ASSETS.fetch(request);
      const headers = new Headers(assetResponse.headers);
      headers.set("Permissions-Policy", "camera=(self), microphone=(self), display-capture=(self)");
      headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
      if (["/", "/index.html", "/app.js", "/styles.css", "/ppe-worker.js"].includes(url.pathname) || !url.pathname.includes(".")) headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
      return new Response(assetResponse.body, { status: assetResponse.status, statusText: assetResponse.statusText, headers });
    } catch (err) {
      console.error(err);
      return error("서버 처리 중 오류가 발생했습니다.", 500, String(err?.message || err));
    }
  },
};
