import { DurableObject } from "cloudflare:workers";

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
  `CREATE INDEX IF NOT EXISTS idx_media_updated_at ON media(updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_events_occurred_at ON events(occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_events_device_id ON events(device_id)`,
  `CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices(last_seen DESC)`,
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
    version: 2,
    zones: [{
      id: "zone-default",
      name: "출입 제한 구역",
      severity: "high",
      enabled: true,
      points: [[0.62, 0.28], [0.95, 0.28], [0.95, 0.93], [0.62, 0.93]],
    }],
    rules: {
      dangerZone: true,
      helmet: true,
      safetyGlasses: true,
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
    detection: { confidence: 0.31, consecutiveFrames: 2, intervalMs: 1000 },
  };
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
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected websocket", { status: 426 });
    const url = new URL(request.url);
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
    config: safeJsonParse(row.config_json, defaultConfig()),
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
    return json({ ok: true, data: { ok: true, service: env.APP_NAME || "스마트 안전지킴이", company: env.COMPANY_NAME || "POSCO Future M", time: nowIso(), realtime: Boolean(env.SIGNALING), browserEdition: true } });
  }

  const realtimeResponse = await handleRealtime(request, env);
  if (realtimeResponse) return realtimeResponse;

  const auth = await requireSession(request, env);
  if (auth.response) return auth.response;
  const isAdmin = auth.session.role === "admin";

  await ensureSchema(env);

  if (path === "/api/ice" && method === "GET") {
    let extra = [];
    try { extra = env.TURN_ICE_SERVERS ? JSON.parse(env.TURN_ICE_SERVERS) : []; } catch { extra = []; }
    return json({ ok: true, data: { iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }, ...(Array.isArray(extra) ? extra : [])] } });
  }

  const adminOnly = path.startsWith("/api/dashboard/") || path === "/api/devices" || path === "/api/events" || path.startsWith("/api/reports/") || path.startsWith("/api/admin/") || path.startsWith("/api/demo/") || (path.startsWith("/api/devices/") && method !== "GET") || path.match(/^\/api\/events\/[^/]+\/ack$/);
  if (adminOnly && !isAdmin) return error("관리자 권한이 필요합니다.", 403);

  if (path === "/api/dashboard/summary" && method === "GET") return json({ ok: true, data: await getSummary(env) });
  if (path === "/api/devices" && method === "GET") return json({ ok: true, data: await getDevices(env) });
  if (path === "/api/events" && method === "GET") return json({ ok: true, data: await getEvents(env, url) });

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
    const requestedConfig = body.config && typeof body.config === "object" ? body.config : defaultConfig();
    const current = await env.DB.prepare("SELECT config_json FROM devices WHERE id=?").bind(id).first();
    const config = current?.config_json ? safeJsonParse(current.config_json, requestedConfig) : requestedConfig;
    await env.DB.prepare(`INSERT INTO devices (id,name,site,area,camera_label,status,agent_version,last_seen,fps,cpu,memory,people_count,current_risk,preview_key,config_json,created_at,updated_at) VALUES (?,?,?,?,?,'online',?,?,0,0,0,0,'정상',NULL,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,site=excluded.site,area=excluded.area,camera_label=excluded.camera_label,status='online',agent_version=excluded.agent_version,last_seen=excluded.last_seen,updated_at=excluded.updated_at`).bind(id, String(body.name || id), String(body.site || "미지정 사업장"), String(body.area || "미지정 구역"), String(body.cameraLabel || "브라우저 카메라"), String(body.agentVersion || "browser-2.0"), now, JSON.stringify(config), now, now).run();
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
    return json({ ok: true, data: safeJsonParse(row.config_json, defaultConfig()) });
  }
  if (configMatch && method === "PUT") {
    if (!isAdmin) return error("관리자 권한이 필요합니다.", 403);
    const deviceId = decodeURIComponent(configMatch[1]);
    const body = await readJson(request);
    const config = body.config && typeof body.config === "object" ? body.config : body;
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
  const upstream = await fetch(modelUrl, { redirect: "follow", headers: { "user-agent": "POSCO-FutureM-Smart-Safety-Guardian/2.0" } });
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
      if (url.pathname === "/" || !url.pathname.includes(".")) headers.set("Cache-Control", "no-cache");
      return new Response(assetResponse.body, { status: assetResponse.status, statusText: assetResponse.statusText, headers });
    } catch (err) {
      console.error(err);
      return error("서버 처리 중 오류가 발생했습니다.", 500, String(err?.message || err));
    }
  },
};
