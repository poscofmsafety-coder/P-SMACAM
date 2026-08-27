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
    camera_label TEXT NOT NULL DEFAULT '노트북 웹캠',
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
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
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
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new Error("요청 본문이 올바른 JSON이 아닙니다.");
  }
}

async function ensureSchema(env) {
  if (schemaReady) return;
  if (!env.DB) throw new Error("D1 바인딩 DB가 없습니다.");
  if (!schemaPromise) {
    schemaPromise = env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql)))
      .then(async () => {
        if (env.BROWSER_EDITION === "true") {
          await env.DB.batch([
            env.DB.prepare(`DELETE FROM events WHERE device_id IN (
              SELECT id FROM devices WHERE agent_version LIKE 'demo-%' OR agent_version LIKE 'simulator-%'
            )`),
            env.DB.prepare(`DELETE FROM devices WHERE agent_version LIKE 'demo-%' OR agent_version LIKE 'simulator-%'`),
          ]);
        }
        schemaReady = true;
      })
      .catch((err) => {
        schemaPromise = null;
        throw err;
      });
  }
  await schemaPromise;
}

function defaultConfig() {
  return {
    version: 1,
    zones: [
      {
        id: "zone-default",
        name: "출입 제한 구역",
        severity: "high",
        enabled: true,
        points: [
          [0.62, 0.28],
          [0.95, 0.28],
          [0.95, 0.93],
          [0.62, 0.93],
        ],
      },
    ],
    rules: {
      dangerZone: true,
      helmet: false,
      safetyGlasses: false,
      harness: false,
      hookConnected: false,
      fall: true,
      unsafePosture: false,
      forklift: false,
      heavyEquipmentProximity: false,
      obstacle: false,
      blockedAisle: false,
      smoke: false,
      fire: false,
    },
    voice: {
      enabled: true,
      cooldownSeconds: 10,
      volume: 0.9,
    },
  };
}

const DEMO_DEVICES = [
  {
    id: "laptop-001",
    name: "노트북 1",
    site: "포항 양극재 1공장",
    area: "원료 투입구역",
    status: "online",
    fps: 13.8,
    cpu: 36,
    memory: 48,
    people: 2,
    risk: "정상",
  },
  {
    id: "laptop-002",
    name: "노트북 2",
    site: "광양 양극재 공장",
    area: "물류·지게차 통로",
    status: "online",
    fps: 11.4,
    cpu: 42,
    memory: 55,
    people: 3,
    risk: "주의",
  },
  {
    id: "laptop-003",
    name: "노트북 3",
    site: "포항 음극재 공장",
    area: "설비 정비구역",
    status: "offline",
    fps: 0,
    cpu: 0,
    memory: 0,
    people: 0,
    risk: "연결 끊김",
  },
];

const DEMO_EVENTS = [
  {
    device: "laptop-002",
    type: "FORKLIFT_APPROACH",
    category: "중장비",
    severity: "high",
    message: "지게차가 작업자 통행구역에 접근했습니다.",
    minutesAgo: 2,
  },
  {
    device: "laptop-001",
    type: "DANGER_ZONE_ENTRY",
    category: "위험구역",
    severity: "high",
    message: "출입 제한 구역에 작업자가 진입했습니다.",
    minutesAgo: 8,
  },
  {
    device: "laptop-002",
    type: "HELMET_NOT_DETECTED",
    category: "보호구",
    severity: "medium",
    message: "안전모 미착용 의심 상황이 감지되었습니다.",
    minutesAgo: 19,
  },
  {
    device: "laptop-001",
    type: "FALL_CANDIDATE",
    category: "불안전 행동",
    severity: "critical",
    message: "넘어짐 의심 자세가 일정 시간 지속되었습니다.",
    minutesAgo: 54,
  },
];

async function seedDemo(env, force = false) {
  if (env.DEMO_MODE !== "true") return;
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM devices").first();
  if (!force && Number(row?.count || 0) > 0) return;

  if (force) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM events"),
      env.DB.prepare("DELETE FROM devices"),
    ]);
  }

  const now = Date.now();
  const statements = [];
  for (const device of DEMO_DEVICES) {
    const created = new Date(now - 86400000).toISOString();
    const lastSeen = device.status === "online"
      ? new Date(now - 15000).toISOString()
      : new Date(now - 720000).toISOString();
    statements.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO devices
        (id, name, site, area, camera_label, status, agent_version, last_seen, fps, cpu, memory, people_count, current_risk, preview_key, config_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
      ).bind(
        device.id,
        device.name,
        device.site,
        device.area,
        "노트북 내장 카메라",
        device.status,
        "demo-1.0",
        lastSeen,
        device.fps,
        device.cpu,
        device.memory,
        device.people,
        device.risk,
        JSON.stringify(defaultConfig()),
        created,
        lastSeen,
      )
    );
  }

  for (const event of DEMO_EVENTS) {
    const occurred = new Date(now - event.minutesAgo * 60000).toISOString();
    statements.push(
      env.DB.prepare(
        `INSERT INTO events
        (id, device_id, type, category, severity, message, occurred_at, acknowledged, status, snapshot_key, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, '확인 필요', NULL, '{}', ?)`
      ).bind(
        randomId("evt"),
        event.device,
        event.type,
        event.category,
        event.severity,
        event.message,
        occurred,
        occurred,
      )
    );
  }

  if (statements.length) await env.DB.batch(statements);
}

function agentAuthorized(request, env) {
  const expected = env.AGENT_API_KEY;
  if (!expected) return true;
  const auth = request.headers.get("authorization") || "";
  return auth === `Bearer ${expected}`;
}

function mapDevice(row) {
  const lastSeenMs = row.last_seen ? Date.parse(row.last_seen) : 0;
  const isRecent = lastSeenMs > Date.now() - 90000;
  const status = row.status === "offline" ? "offline" : isRecent ? "online" : "offline";
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

  let sql = `SELECT e.*, d.name AS device_name, d.site AS site
             FROM events e LEFT JOIN devices d ON d.id = e.device_id WHERE 1=1`;
  const bindings = [];
  if (deviceId) {
    sql += " AND e.device_id = ?";
    bindings.push(deviceId);
  }
  if (category) {
    sql += " AND e.category = ?";
    bindings.push(category);
  }
  if (severity) {
    sql += " AND e.severity = ?";
    bindings.push(severity);
  }
  sql += " ORDER BY e.occurred_at DESC LIMIT ?";
  bindings.push(limit);

  const result = await env.DB.prepare(sql).bind(...bindings).all();
  return (result.results || []).map(mapEvent);
}

async function getSummary(env) {
  const devices = await getDevices(env);
  const eventsResult = await env.DB.prepare(
    "SELECT * FROM events WHERE occurred_at >= ? ORDER BY occurred_at DESC"
  ).bind(new Date(Date.now() - 86400000).toISOString()).all();
  const events = eventsResult.results || [];

  const online = devices.filter((d) => d.status === "online").length;
  const people = devices.reduce((sum, d) => sum + d.peopleCount, 0);
  const high = events.filter((e) => e.severity === "high" || e.severity === "critical").length;
  const unacked = events.filter((e) => !e.acknowledged).length;

  const categoryCounts = {};
  for (const event of events) {
    categoryCounts[event.category] = (categoryCounts[event.category] || 0) + 1;
  }

  return {
    online,
    totalDevices: devices.length,
    people,
    todayEvents: events.length,
    highRisk: high,
    unacknowledged: unacked,
    categoryCounts,
    generatedAt: nowIso(),
  };
}

function exactArrayBuffer(value) {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  }
  return new Uint8Array(value).buffer;
}

async function putImage(env, key, bytes, contentType = "image/jpeg") {
  const buffer = exactArrayBuffer(bytes);
  // D1 rows have a 2 MB upper bound. Keep demo images comfortably below it.
  if (!buffer.byteLength || buffer.byteLength > 1_500_000) return null;
  await env.DB.prepare(
    `INSERT INTO media (key, content_type, bytes, byte_length, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       content_type=excluded.content_type,
       bytes=excluded.bytes,
       byte_length=excluded.byte_length,
       updated_at=excluded.updated_at`
  ).bind(key, contentType, buffer, buffer.byteLength, nowIso()).run();
  return key;
}

function base64ToBytes(base64) {
  const clean = base64.includes(",") ? base64.split(",").pop() : base64;
  const binary = atob(clean || "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  await ensureSchema(env);
  await seedDemo(env);

  if (path === "/api/health" && method === "GET") {
    return json({
      ok: true,
      service: env.APP_NAME || "스마트 안전지킴이",
      company: env.COMPANY_NAME || "POSCO Future M",
      time: nowIso(),
      storage: { d1: Boolean(env.DB), media: "d1" },
      browserEdition: env.BROWSER_EDITION === "true",
    });
  }

  if (path === "/api/dashboard/summary" && method === "GET") {
    return json({ ok: true, data: await getSummary(env) });
  }

  if (path === "/api/devices" && method === "GET") {
    return json({ ok: true, data: await getDevices(env) });
  }

  if (path === "/api/events" && method === "GET") {
    return json({ ok: true, data: await getEvents(env, url) });
  }

  if (path === "/api/reports/daily" && method === "GET") {
    const days = Math.min(Math.max(Number(url.searchParams.get("days") || 7), 1), 31);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const result = await env.DB.prepare(
      `SELECT substr(occurred_at, 1, 10) AS day, category, severity, COUNT(*) AS count
       FROM events WHERE occurred_at >= ?
       GROUP BY day, category, severity ORDER BY day ASC`
    ).bind(since).all();
    return json({ ok: true, data: result.results || [] });
  }

  if (path === "/api/agents/register" && method === "POST") {
    if (!agentAuthorized(request, env)) return error("Agent 인증에 실패했습니다.", 401);
    const body = await readJson(request);
    const id = String(body.deviceId || "").trim();
    if (!id) return error("deviceId가 필요합니다.");
    const now = nowIso();
    const config = body.config && typeof body.config === "object" ? body.config : defaultConfig();

    await env.DB.prepare(
      `INSERT INTO devices
       (id, name, site, area, camera_label, status, agent_version, last_seen, fps, cpu, memory, people_count, current_risk, preview_key, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'online', ?, ?, 0, 0, 0, 0, '정상', NULL, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name, site=excluded.site, area=excluded.area,
         camera_label=excluded.camera_label, status='online',
         agent_version=excluded.agent_version, last_seen=excluded.last_seen,
         updated_at=excluded.updated_at`
    ).bind(
      id,
      String(body.name || id),
      String(body.site || "미지정 사업장"),
      String(body.area || "미지정 구역"),
      String(body.cameraLabel || "노트북 웹캠"),
      String(body.agentVersion || "0.1.0"),
      now,
      JSON.stringify(config),
      now,
      now,
    ).run();

    const device = await env.DB.prepare("SELECT * FROM devices WHERE id = ?").bind(id).first();
    return json({ ok: true, data: mapDevice(device) }, 201);
  }

  if (path === "/api/agents/heartbeat" && method === "POST") {
    if (!agentAuthorized(request, env)) return error("Agent 인증에 실패했습니다.", 401);
    const body = await readJson(request);
    const id = String(body.deviceId || "").trim();
    if (!id) return error("deviceId가 필요합니다.");
    const now = nowIso();

    await env.DB.prepare(
      `UPDATE devices SET
        status='online', last_seen=?, fps=?, cpu=?, memory=?,
        people_count=?, current_risk=?, agent_version=COALESCE(?, agent_version), updated_at=?
       WHERE id=?`
    ).bind(
      now,
      Number(body.fps || 0),
      Number(body.cpu || 0),
      Number(body.memory || 0),
      Number(body.peopleCount || 0),
      String(body.currentRisk || "정상"),
      body.agentVersion ? String(body.agentVersion) : null,
      now,
      id,
    ).run();

    return json({ ok: true, serverTime: now });
  }

  if (path === "/api/agents/offline" && method === "POST") {
    if (!agentAuthorized(request, env)) return error("Agent 인증에 실패했습니다.", 401);
    const body = await readJson(request).catch(() => ({}));
    const id = String(body.deviceId || "").trim();
    if (!id) return error("deviceId가 필요합니다.");
    const now = nowIso();
    await env.DB.prepare(
      "UPDATE devices SET status='offline', people_count=0, current_risk='연결 종료', updated_at=? WHERE id=?"
    ).bind(now, id).run();
    return json({ ok: true, serverTime: now });
  }

  const previewMatch = path.match(/^\/api\/agents\/preview\/([^/]+)$/);
  if (previewMatch && method === "POST") {
    if (!agentAuthorized(request, env)) return error("Agent 인증에 실패했습니다.", 401);
    const deviceId = decodeURIComponent(previewMatch[1]);
    const bytes = await request.arrayBuffer();
    if (!bytes.byteLength) return error("이미지 본문이 비어 있습니다.");
    if (bytes.byteLength > 700_000) return error("무료판 프리뷰 이미지는 700KB 이하여야 합니다.", 413);
    const key = `previews/${deviceId}/latest.jpg`;
    const storedKey = await putImage(
      env,
      key,
      bytes,
      request.headers.get("content-type") || "image/jpeg"
    );
    await env.DB.prepare(
      "UPDATE devices SET preview_key=?, last_seen=?, status='online', updated_at=? WHERE id=?"
    ).bind(storedKey, nowIso(), nowIso(), deviceId).run();
    return json({
      ok: true,
      previewUrl: storedKey ? `/media/${encodeURIComponent(storedKey)}` : null,
      mediaStored: Boolean(storedKey),
      storage: "d1",
    });
  }

  if (path === "/api/agents/event" && method === "POST") {
    if (!agentAuthorized(request, env)) return error("Agent 인증에 실패했습니다.", 401);
    const body = await readJson(request);
    const deviceId = String(body.deviceId || "").trim();
    if (!deviceId) return error("deviceId가 필요합니다.");

    const eventId = String(body.id || randomId("evt"));
    const occurredAt = String(body.occurredAt || nowIso());
    let snapshotKey = null;
    if (body.snapshotBase64) {
      const bytes = base64ToBytes(String(body.snapshotBase64));
      if (bytes.byteLength <= 1_200_000) {
        const candidateKey = `events/${deviceId}/${eventId}.jpg`;
        snapshotKey = await putImage(env, candidateKey, bytes, "image/jpeg");
      }
    }

    await env.DB.prepare(
      `INSERT INTO events
       (id, device_id, type, category, severity, message, occurred_at, acknowledged, status, snapshot_key, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, '확인 필요', ?, ?, ?)`
    ).bind(
      eventId,
      deviceId,
      String(body.type || "UNKNOWN"),
      String(body.category || "기타"),
      String(body.severity || "medium"),
      String(body.message || "안전 이벤트가 발생했습니다."),
      occurredAt,
      snapshotKey,
      JSON.stringify(body.metadata || {}),
      nowIso(),
    ).run();

    await env.DB.prepare(
      "UPDATE devices SET current_risk=?, last_seen=?, status='online', updated_at=? WHERE id=?"
    ).bind(
      String(body.severity === "critical" ? "위험" : "주의"),
      nowIso(),
      nowIso(),
      deviceId,
    ).run();

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
    const deviceId = decodeURIComponent(configMatch[1]);
    const body = await readJson(request);
    const config = body.config && typeof body.config === "object" ? body.config : body;
    const result = await env.DB.prepare(
      "UPDATE devices SET config_json=?, updated_at=? WHERE id=?"
    ).bind(JSON.stringify(config), nowIso(), deviceId).run();
    if (!result.meta?.changes) return error("장치를 찾을 수 없습니다.", 404);
    return json({ ok: true, data: config });
  }

  const ackMatch = path.match(/^\/api\/events\/([^/]+)\/ack$/);
  if (ackMatch && method === "POST") {
    const eventId = decodeURIComponent(ackMatch[1]);
    const body = await readJson(request).catch(() => ({}));
    const status = String(body.status || "확인 완료");
    const result = await env.DB.prepare(
      "UPDATE events SET acknowledged=1, status=? WHERE id=?"
    ).bind(status, eventId).run();
    if (!result.meta?.changes) return error("이벤트를 찾을 수 없습니다.", 404);
    return json({ ok: true });
  }

  if (path === "/api/admin/clear-all" && method === "POST") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM events"),
      env.DB.prepare("DELETE FROM devices"),
      env.DB.prepare("DELETE FROM media"),
    ]);
    return json({ ok: true });
  }

  const deleteDeviceMatch = path.match(/^\/api\/devices\/([^/]+)$/);
  if (deleteDeviceMatch && method === "DELETE") {
    const deviceId = decodeURIComponent(deleteDeviceMatch[1]);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM events WHERE device_id=?").bind(deviceId),
      env.DB.prepare("DELETE FROM media WHERE key LIKE ? OR key LIKE ?")
        .bind(`previews/${deviceId}/%`, `events/${deviceId}/%`),
      env.DB.prepare("DELETE FROM devices WHERE id=?").bind(deviceId),
    ]);
    return json({ ok: true });
  }

  if (path === "/api/devices/cleanup-offline" && method === "POST") {
    const cutoff = new Date(Date.now() - 120000).toISOString();
    const rows = await env.DB.prepare(
      "SELECT id FROM devices WHERE status='offline' OR last_seen IS NULL OR last_seen < ?"
    ).bind(cutoff).all();
    const ids = (rows.results || []).map((row) => row.id);
    if (ids.length) {
      const placeholders = ids.map(() => "?").join(",");
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM events WHERE device_id IN (${placeholders})`).bind(...ids),
        env.DB.prepare(`DELETE FROM devices WHERE id IN (${placeholders})`).bind(...ids),
      ]);
    }
    return json({ ok: true, deleted: ids.length });
  }

  if (path === "/api/demo/reset" && method === "POST") {
    await seedDemo(env, true);
    return json({ ok: true });
  }

  if (path === "/api/demo/clear" && method === "POST") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM events WHERE device_id IN (SELECT id FROM devices WHERE agent_version LIKE 'demo-%')"),
      env.DB.prepare("DELETE FROM devices WHERE agent_version LIKE 'demo-%'"),
    ]);
    return json({ ok: true });
  }

  if (path === "/api/demo/simulate" && method === "POST") {
    const body = await readJson(request).catch(() => ({}));
    const devices = await getDevices(env);
    if (!devices.length) return error("시뮬레이션할 장치가 없습니다.");
    const device = devices.find((d) => d.id === body.deviceId) || devices[0];
    const samples = [
      ["DANGER_ZONE_ENTRY", "위험구역", "high", "출입 제한 구역에 작업자가 진입했습니다."],
      ["HELMET_NOT_DETECTED", "보호구", "medium", "안전모 미착용 의심 상황이 감지되었습니다."],
      ["FORKLIFT_APPROACH", "중장비", "high", "지게차가 지나갑니다. 주의하세요."],
      ["FALL_CANDIDATE", "불안전 행동", "critical", "넘어짐 의심 상황이 감지되었습니다."],
      ["BLOCKED_AISLE", "작업환경", "medium", "안전통로 적치물 의심 상태가 감지되었습니다."],
    ];
    const selected = samples[Math.floor(Math.random() * samples.length)];
    const eventId = randomId("evt");
    const now = nowIso();
    await env.DB.prepare(
      `INSERT INTO events
       (id, device_id, type, category, severity, message, occurred_at, acknowledged, status, snapshot_key, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, '확인 필요', NULL, '{"simulated":true}', ?)`
    ).bind(eventId, device.id, selected[0], selected[1], selected[2], selected[3], now, now).run();
    return json({ ok: true, id: eventId });
  }

  return error("API 경로를 찾을 수 없습니다.", 404);
}

async function handleMedia(request, env) {
  await ensureSchema(env);
  const url = new URL(request.url);
  const encoded = url.pathname.replace(/^\/media\//, "");
  const key = decodeURIComponent(encoded);
  if (!key) return error("미디어 키가 없습니다.", 404);

  const row = await env.DB.prepare(
    "SELECT content_type, bytes, byte_length, updated_at FROM media WHERE key=?"
  ).bind(key).first();
  if (!row) return error("이미지를 찾을 수 없습니다.", 404);

  const body = new Uint8Array(row.bytes || []);
  const headers = new Headers({
    "content-type": row.content_type || "image/jpeg",
    "content-length": String(row.byte_length || body.byteLength),
    "cache-control": "no-store",
    "x-media-storage": "d1",
  });
  return new Response(body, { headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
          "access-control-allow-headers": "content-type,authorization",
        },
      });
    }

    try {
      if (url.pathname.startsWith("/api/")) {
        const response = await handleApi(request, env, ctx);
        response.headers.set("access-control-allow-origin", "*");
        return response;
      }
      if (url.pathname.startsWith("/media/")) {
        return await handleMedia(request, env);
      }
      const assetResponse = await env.ASSETS.fetch(request);
      const headers = new Headers(assetResponse.headers);
      headers.set("Permissions-Policy", "camera=(self), microphone=()");
      headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
      headers.set("X-Content-Type-Options", "nosniff");
      return new Response(assetResponse.body, {
        status: assetResponse.status,
        statusText: assetResponse.statusText,
        headers,
      });
    } catch (err) {
      console.error(err);
      return error("서버 처리 중 오류가 발생했습니다.", 500, String(err?.message || err));
    }
  },
};
