const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isMobile = () => matchMedia("(max-width: 820px)").matches || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);

const pageTitles = {
  overview: "통합 대시보드",
  guard: "현장 지킴이",
  live: "실시간 관제",
  "stop-work": "작업중지권 관제",
  devices: "장치 관리",
  zones: "위험구역 설정",
  ppe: "근로자 보호구",
  behavior: "불안전 행동",
  environment: "작업환경",
  equipment: "중장비",
  tbm: "TBM 안전소통",
  events: "이벤트 센터",
  reports: "리포트",
  settings: "설정",
  "user-help": "사용 안내",
};

const ruleGroups = {
  ppe: [
    ["helmet", "안전모", "안전모와 미착용 상태를 감지하고 한국어 음성으로 안내합니다.", true],
    ["safetyGlasses", "보안경", "보안경과 미착용 의심 상태를 감지합니다.", true],
    ["mask", "마스크", "마스크 착용 및 미착용 의심 상태를 감지하고 음성으로 안내합니다.", true],
    ["harness", "안전대", "안전대 미착용 의심 상태를 확인합니다.", false],
    ["hookConnected", "안전대 후크 체결", "현장 전용 학습모델 연결을 위한 확장 규칙입니다.", false],
  ],
  behavior: [
    ["dangerZone", "위험구역 진입", "작업자의 발 위치가 설정 구역 안으로 들어오면 경고합니다.", false],
    ["fall", "넘어짐 의심", "넘어짐 객체가 반복 감지되면 관리자 확인을 요청합니다.", true],
    ["unsafePosture", "불안전 자세", "작업 자세 이상을 확인하는 확장 규칙입니다.", false],
    ["longStay", "위험구역 장시간 체류", "지정 시간 이상 체류한 작업자를 경고합니다.", false],
  ],
  environment: [
    ["obstacle", "통로 장애물", "통로 내 장애물·적치물을 확인하는 확장 규칙입니다.", false],
    ["blockedAisle", "안전통로 점유", "안전통로 침범 상태를 확인합니다.", false],
    ["smoke", "연기", "연기 발생 의심 장면을 관리자에게 알립니다.", false],
    ["fire", "화재", "화염 의심 장면을 관리자에게 알립니다.", false],
  ],
  equipment: [
    ["forklift", "지게차", "지게차 접근 시 ‘지게차가 지나갑니다’ 음성 경고를 제공합니다.", false],
    ["heavyEquipmentProximity", "중장비 근접", "작업자와 중장비의 안전거리 이탈을 확인합니다.", false],
    ["crane", "크레인·인양물", "인양반경 내 작업자 접근을 확인하는 확장 규칙입니다.", false],
    ["agv", "AGV·운반차", "무인운반차 동선과 작업자 접근을 확인합니다.", false],
  ],
};

const defaultConfig = () => ({
  version: 4,
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
  detection: { confidence: 0.28, consecutiveFrames: 3, intervalMs: 1000, inferMissingPpeFromPerson: true, minPersonHeightRatio: 0.20 },
});

const state = {
  session: null,
  currentPage: "overview",
  summary: null,
  devices: [],
  events: [],
  workStops: [],
  tbmActive: null,
  selectedWorkStopId: null,
  photoAnalysisText: "",
  dashboardTimer: null,
  iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }],
  zonePoints: [],
  zoneConfig: null,
  zoneBackground: null,
  liveViewDeviceId: null,
};

const realtime = {
  adminSignals: new Map(),
  adminVideoPeers: new Map(),
  adminRemoteStreams: new Map(),
  guardVideoPeers: new Map(),
  pendingIce: new Map(),
};

const guard = {
  active: false,
  starting: false,
  stream: null,
  signal: null,
  config: defaultConfig(),
  worker: null,
  modelReady: false,
  inferenceBusy: false,
  inferenceTimer: null,
  heartbeatTimer: null,
  configTimer: null,
  previewTimer: null,
  tbmTimer: null,
  peopleCount: 0,
  inferenceFps: 0,
  detections: [],
  currentRisk: "정상",
  viewerCount: 0,
  streaks: new Map(),
  lastEvents: new Map(),
  warningTimer: null,
  modelError: null,
  voiceQueue: [],
  voiceSpeaking: false,
  currentVoiceText: null,
  activeTbm: null,
};

const stopWorkState = {
  selected: null,
  alarmTimer: null,
};

const callState = {
  status: "idle",
  direction: null,
  deviceId: null,
  peerId: null,
  signal: null,
  callId: null,
  pc: null,
  localStream: null,
  localTrack: null,
  remoteStream: null,
  ringTimer: null,
  audioContext: null,
  timeoutTimer: null,
  muted: false,
  remotePlaybackBlocked: false,
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function uuid(prefix = "id") {
  return `${prefix}-${crypto.randomUUID()}`;
}

function formatDate(value, withDate = true) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("ko-KR", {
    ...(withDate ? { month: "2-digit", day: "2-digit" } : {}),
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function toast(message, duration = 3200) {
  const item = document.createElement("div");
  item.className = "toast";
  item.textContent = message;
  $("#toastContainer").append(item);
  setTimeout(() => item.remove(), duration);
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !(options.body instanceof Blob) && !(options.body instanceof ArrayBuffer) && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(path, { ...options, headers, credentials: "include" });
  const type = response.headers.get("content-type") || "";
  const payload = type.includes("application/json") ? await response.json() : await response.text();
  if (response.status === 401 && !path.startsWith("/api/auth/")) {
    showLogin(state.session?.role || "admin");
    throw new Error("로그인이 만료되었습니다.");
  }
  if (!response.ok) throw new Error(payload?.error || payload?.message || String(payload) || `HTTP ${response.status}`);
  if (payload && typeof payload === "object" && Object.prototype.hasOwnProperty.call(payload, "data")) return payload.data;
  return payload;
}

function showLogin(role = "admin") {
  state.session = null;
  $("#appShell").hidden = true;
  $("#loginScreen").hidden = false;
  setLoginRole(role);
  $("#loginPin").value = "";
  setTimeout(() => $("#loginPin").focus(), 50);
}

function setLoginRole(role) {
  $("#loginRole").value = role;
  $$('[data-login-role]').forEach((button) => button.classList.toggle("active", button.dataset.loginRole === role));
  $("#loginHelp").textContent = role === "admin"
    ? "관리자용 통합관제 화면으로 접속합니다."
    : "현장 카메라와 무전 기능을 사용하는 사용자 화면으로 접속합니다.";
}

async function restoreSession() {
  try {
    const session = await api("/api/auth/me");
    applySession(session);
  } catch {
    const preferred = new URL(location.href).searchParams.get("mode") === "user" || location.pathname.startsWith("/guard") ? "user" : "admin";
    showLogin(preferred);
  }
}

function applySession(session) {
  state.session = session;
  $("#loginScreen").hidden = true;
  $("#appShell").hidden = false;
  const isAdmin = session.role === "admin";
  $$(".admin-only").forEach((element) => { element.hidden = !isAdmin; });
  $$(".user-only").forEach((element) => { element.hidden = isAdmin; });
  $("#roleBadge").textContent = isAdmin ? "관리자" : "현장 사용자";
  goToPage(isAdmin ? "overview" : "guard");
  if (isAdmin) {
    loadDashboard();
    startDashboardPolling();
  } else {
    stopDashboardPolling();
    loadGuardProfile();
    loadActiveTbm();
  }
}

async function login(event) {
  event.preventDefault();
  const button = $("#loginButton");
  button.disabled = true;
  try {
    const session = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ role: $("#loginRole").value, pin: $("#loginPin").value }),
    });
    unlockAudio();
    applySession(session);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function logout() {
  try { await api("/api/auth/logout", { method: "POST" }); } catch { /* noop */ }
  stopDashboardPolling();
  closeAllAdminSignals();
  if (guard.active) await stopGuard();
  endCall(false);
  showLogin("admin");
}

function goToPage(page) {
  if (!pageTitles[page]) return;
  if (state.session?.role === "user" && !["guard", "user-help"].includes(page)) page = "guard";
  state.currentPage = page;
  $$(".page").forEach((section) => section.classList.toggle("active", section.id === `page-${page}`));
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.page === page));
  $("#pageTitle").textContent = pageTitles[page];
  document.body.classList.remove("sidebar-open");
  if (state.session?.role === "admin") {
    syncVisibleDeviceVideos();
    syncAdminWatchRequests();
    if (page === "zones") prepareZoneEditor();
    if (["ppe", "behavior", "environment", "equipment"].includes(page)) loadRuleEditor(page);
    if (page === "reports") renderReports();
    if (page === "stop-work") renderWorkStops();
    if (page === "tbm") renderTbmDashboard();
  }
}

function updateClock() {
  const now = new Date();
  $("#clock").textContent = `${new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" }).format(now)}\n${new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(now)}`;
}

function startDashboardPolling() {
  stopDashboardPolling();
  state.dashboardTimer = setInterval(() => loadDashboard(true), 15000);
}

function stopDashboardPolling() {
  clearInterval(state.dashboardTimer);
  state.dashboardTimer = null;
}

async function loadDashboard(silent = false) {
  if (state.session?.role !== "admin") return;
  if (!silent) document.body.classList.add("loading");
  try {
    const [summary, devices, events, workStops, tbmActive] = await Promise.all([
      api("/api/dashboard/summary"),
      api("/api/devices"),
      api("/api/events?limit=120"),
      api("/api/work-stop"),
      api("/api/tbm/active"),
    ]);
    state.summary = summary;
    state.devices = devices;
    state.events = events;
    state.workStops = Array.isArray(workStops) ? workStops : [];
    state.tbmActive = tbmActive && tbmActive.id ? tbmActive : null;
    renderKpis();
    reconcileDeviceCards($("#overviewDevices"), false);
    reconcileDeviceCards($("#liveDevices"), true);
    renderDevicesTable();
    renderEvents();
    renderCategoryChart();
    renderBriefing();
    renderWorkStops();
    renderTbmDashboard();
    updateWorkStopOverviewAlert();
    updateDeviceSelects();
    reconcileAdminSignals();
    if (state.liveViewDeviceId) {
      const selected = state.devices.find((device) => device.id === state.liveViewDeviceId);
      if (selected) updateLiveViewDetails(selected);
    }
  } catch (error) {
    toast(`관제 데이터 오류: ${error.message}`);
  } finally {
    document.body.classList.remove("loading");
  }
}

function renderKpis() {
  const s = state.summary || {};
  const cards = [
    [`${s.online || 0}/${s.totalDevices || 0}`, "정상 연결"],
    [s.people || 0, "AI 감지 인원"],
    [s.todayEvents || 0, "최근 24시간"],
    [s.highRisk || 0, "고위험 이벤트"],
    [s.activeStops || 0, "작업중지 요청"],
    [s.unacknowledged || 0, "관리자 조치 필요"],
  ];
  $("#kpiGrid").innerHTML = cards.map(([value, label]) => `<article class="kpi-card"><b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span></article>`).join("");
}

function deviceCardMarkup(device, live) {
  return `<article class="device-card" data-device-id="${escapeHtml(device.id)}" data-live="${live ? "1" : "0"}">
    <div class="device-media" role="button" tabindex="0" aria-label="${escapeHtml(device.name)} 실시간 영상 크게 보기">
      <img class="device-preview" alt="${escapeHtml(device.name)} 최근 프리뷰" />
      <video class="device-video" autoplay muted playsinline></video>
      <div class="media-placeholder"><div>카메라 연결 대기<br /><small>지킴이 시작 후 실시간 영상이 표시됩니다.</small></div></div>
      <span class="connection-badge"></span>
      <span class="viewer-badge">WebRTC 대기</span>
      <span class="connection-note">실시간 연결 준비 중</span>
      <span class="expand-hint">⛶ 클릭하여 크게 보기</span>
    </div>
    <div class="device-body">
      <div class="device-title-row"><div><h4></h4><p></p></div><span class="device-risk"></span></div>
      <div class="device-stats"><div><span>FPS</span><b data-stat="fps">0</b></div><div><span>작업자</span><b data-stat="people">0명</b></div><div><span>최근 연결</span><b data-stat="seen">-</b></div></div>
      <div class="device-actions"><button class="watch-button" type="button">영상 재연결</button><button class="analyze-button" type="button">사진 분석</button><button class="call-button" type="button">무전 호출</button></div>
    </div>
  </article>`;
}

function reconcileDeviceCards(container, live) {
  if (!container) return;
  const existing = new Map($$(".device-card", container).map((card) => [card.dataset.deviceId, card]));
  for (const device of state.devices) {
    let card = existing.get(device.id);
    if (!card) {
      const wrapper = document.createElement("div");
      wrapper.innerHTML = deviceCardMarkup(device, live);
      card = wrapper.firstElementChild;
      container.append(card);
      $(".watch-button", card).addEventListener("click", () => requestWatch(device.id, true, "low"));
      $(".analyze-button", card).addEventListener("click", () => analyzeDevicePhoto(device.id));
      $(".call-button", card).addEventListener("click", () => initiateAdminCall(device.id));
      const media = $(".device-media", card);
      media.addEventListener("click", () => openLiveView(device.id));
      media.addEventListener("keydown", (event) => {
        if (["Enter", " "].includes(event.key)) {
          event.preventDefault();
          openLiveView(device.id);
        }
      });
    }
    updateDeviceCard(card, device);
    existing.delete(device.id);
  }
  for (const card of existing.values()) card.remove();
  if (!state.devices.length) container.innerHTML = `<div class="panel" style="padding:24px;color:var(--muted)">연결된 현장 장치가 없습니다. 현장 QR로 사용자 모드에 접속해 지킴이를 시작하세요.</div>`;
}

function updateDeviceCard(card, device) {
  $("h4", card).textContent = device.name;
  $(".device-title-row p", card).textContent = `${device.site} · ${device.area}`;
  const risk = $(".device-risk", card);
  risk.textContent = device.currentRisk || "정상";
  risk.classList.toggle("warning", !["정상", "안전"].includes(device.currentRisk));
  $("[data-stat='fps']", card).textContent = Number(device.fps || 0).toFixed(1);
  $("[data-stat='people']", card).textContent = `${device.peopleCount || 0}명`;
  $("[data-stat='seen']", card).textContent = formatDate(device.lastSeen, false);
  const badge = $(".connection-badge", card);
  badge.className = `connection-badge ${device.status === "online" ? "live-badge" : "offline-badge"}`;
  badge.textContent = device.status === "online" ? "● ONLINE" : "○ OFFLINE";
  const preview = $(".device-preview", card);
  if (device.previewUrl && preview.dataset.src !== device.previewUrl) {
    preview.dataset.src = device.previewUrl;
    preview.src = device.previewUrl;
  } else if (!device.previewUrl) {
    preview.removeAttribute("src");
    preview.dataset.src = "";
  }
  attachStreamToCard(card, device.id);
  if (state.liveViewDeviceId === device.id) updateLiveViewDetails(device);
}

function attachStreamToCard(card, deviceId) {
  const video = $(".device-video", card);
  const preview = $(".device-preview", card);
  const stream = realtime.adminRemoteStreams.get(deviceId);
  const note = $(".connection-note", card);
  const viewer = $(".viewer-badge", card);
  const page = card.closest(".page");
  const visible = !page || page.classList.contains("active");
  if (!visible) {
    video.srcObject = null;
    video.hidden = true;
    return;
  }
  if (stream) {
    if (video.srcObject !== stream) video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    video.hidden = false;
    preview.hidden = true;
    note.hidden = true;
    viewer.textContent = "● 실시간 영상";
    video.play().catch(() => {});
  } else {
    video.srcObject = null;
    video.hidden = true;
    preview.hidden = !preview.getAttribute("src");
    note.hidden = false;
    viewer.textContent = state.devices.find((item) => item.id === deviceId)?.status === "online" ? "WebRTC 연결 중" : "장치 오프라인";
    note.textContent = state.devices.find((item) => item.id === deviceId)?.status === "online" ? "실시간 연결 준비 중" : "최근 프리뷰";
  }
}

function attachStreamEverywhere(deviceId) {
  $$(`.device-card[data-device-id="${CSS.escape(deviceId)}"]`).forEach((card) => attachStreamToCard(card, deviceId));
  if (state.liveViewDeviceId === deviceId) attachLiveViewStream();
}

function syncVisibleDeviceVideos() {
  $$(".device-card").forEach((card) => attachStreamToCard(card, card.dataset.deviceId));
}

function updateLiveViewDetails(device) {
  if (!device || state.liveViewDeviceId !== device.id) return;
  $("#liveViewTitle").textContent = device.name || "실시간 영상";
  $("#liveViewSubtitle").textContent = `${device.site || "미지정 사업장"} · ${device.area || "미지정 구역"}`;
  $("#liveViewMetrics").innerHTML = [
    ["상태", device.status === "online" ? "온라인" : "오프라인"],
    ["감지 인원", `${device.peopleCount || 0}명`],
    ["분석 속도", `${Number(device.fps || 0).toFixed(1)} FPS`],
    ["현재 위험", device.currentRisk || "정상"],
    ["최근 연결", formatDate(device.lastSeen)],
  ].map(([label, value]) => `<div><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`).join("");
  const preview = $("#liveViewPreview");
  if (device.previewUrl && preview.dataset.src !== device.previewUrl) {
    preview.dataset.src = device.previewUrl;
    preview.src = device.previewUrl;
  } else if (!device.previewUrl) {
    preview.removeAttribute("src");
    preview.dataset.src = "";
  }
}

function attachLiveViewStream() {
  const deviceId = state.liveViewDeviceId;
  if (!deviceId || $("#liveViewModal").hidden) return;
  const device = state.devices.find((item) => item.id === deviceId);
  const stream = realtime.adminRemoteStreams.get(deviceId);
  const video = $("#liveViewVideo");
  const preview = $("#liveViewPreview");
  const placeholder = $("#liveViewPlaceholder");
  const badge = $("#liveViewBadge");
  if (stream) {
    if (video.srcObject !== stream) video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    video.hidden = false;
    preview.hidden = true;
    placeholder.hidden = true;
    badge.textContent = "● 실시간 WebRTC";
    badge.classList.add("connected");
    video.play().catch(() => {});
  } else {
    video.srcObject = null;
    video.hidden = true;
    if (device?.previewUrl) {
      preview.hidden = false;
      placeholder.hidden = true;
    } else {
      preview.hidden = true;
      placeholder.hidden = false;
    }
    badge.textContent = device?.status === "online" ? "WebRTC 연결 중" : "장치 오프라인";
    badge.classList.remove("connected");
  }
}

function openLiveView(deviceId) {
  if (state.session?.role !== "admin") return;
  state.liveViewDeviceId = deviceId;
  $("#liveViewModal").hidden = false;
  const device = state.devices.find((item) => item.id === deviceId);
  if (device) updateLiveViewDetails(device);
  requestWatch(deviceId, true, "high");
  attachLiveViewStream();
  syncAdminWatchRequests();
}

function closeLiveView() {
  const video = $("#liveViewVideo");
  video.pause();
  video.srcObject = null;
  $("#liveViewModal").hidden = true;
  const previousDeviceId = state.liveViewDeviceId;
  state.liveViewDeviceId = null;
  syncAdminWatchRequests();
  if (previousDeviceId) setTimeout(() => requestWatch(previousDeviceId, true, "low"), 250);
}

async function toggleLiveViewFullscreen() {
  const stage = $("#liveViewStage");
  try {
    if (!document.fullscreenElement) await stage.requestFullscreen();
    else await document.exitFullscreen();
  } catch (error) {
    toast(`전체화면을 열 수 없습니다: ${error.message}`);
  }
}

function renderDevicesTable() {
  const body = $("#deviceTableBody");
  if (!body) return;
  body.innerHTML = state.devices.map((device) => `<tr><td><b>${escapeHtml(device.name)}</b><br /><small>${escapeHtml(device.id)}</small></td><td>${escapeHtml(device.site)}<br /><small>${escapeHtml(device.area)}</small></td><td><span class="status-pill ${device.status}">${device.status === "online" ? "온라인" : "오프라인"}</span></td><td>${device.peopleCount || 0}명</td><td>${formatDate(device.lastSeen)}</td><td><button class="table-action" data-device-call="${escapeHtml(device.id)}">무전</button> <button class="table-action" data-device-delete="${escapeHtml(device.id)}">삭제</button></td></tr>`).join("");
  $$('[data-device-call]', body).forEach((button) => button.addEventListener("click", () => initiateAdminCall(button.dataset.deviceCall)));
  $$('[data-device-delete]', body).forEach((button) => button.addEventListener("click", () => deleteDevice(button.dataset.deviceDelete)));
}

function renderEvents() {
  const events = state.events || [];
  const overview = $("#overviewEvents");
  if (overview) {
    overview.innerHTML = events.slice(0, 7).map((event) => `<div class="event-item"><time>${formatDate(event.occurredAt)}</time><span class="event-device">${escapeHtml(event.deviceName)}</span><span>${escapeHtml(event.message)}</span><span class="severity-pill ${escapeHtml(event.severity)}">${severityLabel(event.severity)}</span></div>`).join("") || `<div class="event-item">최근 이벤트가 없습니다.</div>`;
  }
  renderEventTable();
}

function severityLabel(value) {
  return value === "critical" ? "긴급" : value === "high" ? "위험" : "주의";
}

function renderEventTable() {
  const body = $("#eventTableBody");
  if (!body) return;
  const deviceFilter = $("#eventDeviceFilter")?.value || "";
  const categoryFilter = $("#eventCategoryFilter")?.value || "";
  const severityFilter = $("#eventSeverityFilter")?.value || "";
  const items = state.events.filter((event) => (!deviceFilter || event.deviceId === deviceFilter) && (!categoryFilter || event.category === categoryFilter) && (!severityFilter || event.severity === severityFilter));
  body.innerHTML = items.map((event) => {
    const analysisButton = event.type === "PHOTO_AI_ANALYSIS" && event.metadata?.analysisText
      ? `<button class="table-action" data-analysis-event="${escapeHtml(event.id)}">AI 분석 보기</button>`
      : "";
    const snapshotLink = event.snapshotUrl ? `<a href="${escapeHtml(event.snapshotUrl)}" target="_blank" rel="noopener">사진</a>` : "";
    const action = `${analysisButton} ${snapshotLink} ${event.acknowledged ? "완료" : `<button class="table-action" data-event-ack="${escapeHtml(event.id)}">확인 완료</button>`}`.trim();
    return `<tr><td>${formatDate(event.occurredAt)}</td><td>${escapeHtml(event.deviceName)}</td><td>${escapeHtml(event.category)}</td><td><span class="severity-pill ${escapeHtml(event.severity)}">${severityLabel(event.severity)}</span></td><td>${escapeHtml(event.message)}</td><td>${escapeHtml(event.status)}</td><td>${action || "-"}</td></tr>`;
  }).join("") || `<tr><td colspan="7">조회된 이벤트가 없습니다.</td></tr>`;
  $$('[data-event-ack]', body).forEach((button) => button.addEventListener("click", () => acknowledgeEvent(button.dataset.eventAck)));
  $$('[data-analysis-event]', body).forEach((button) => button.addEventListener("click", () => {
    const event = state.events.find((item) => item.id === button.dataset.analysisEvent);
    if (!event) return;
    state.photoAnalysisText = event.metadata?.analysisText || "";
    showPhotoAnalysisModal(event.snapshotUrl || "", `${event.deviceName} · ${severityLabel(event.severity)}`);
    $("#photoAnalysisText").textContent = state.photoAnalysisText || "분석 결과가 없습니다.";
  }));
}

function renderCategoryChart() {
  const counts = state.summary?.categoryCounts || {};
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, count]) => count));
  $("#categoryChart").innerHTML = entries.map(([name, count]) => `<div class="category-row"><span>${escapeHtml(name)}</span><div class="category-bar"><i style="width:${Math.max(5, count / max * 100)}%"></i></div><b>${count}</b></div>`).join("") || `<div style="color:var(--muted)">오늘 발생한 이벤트가 없습니다.</div>`;
}

function renderBriefing() {
  const s = state.summary || {};
  const top = Object.entries(s.categoryCounts || {}).sort((a, b) => b[1] - a[1])[0];
  const main = s.highRisk > 0 ? `현재 <b>${s.highRisk}건의 고위험 이벤트</b>가 확인되었습니다. 현장 무전과 이벤트 확인 기능을 이용해 조치 여부를 점검하세요.` : `현재 연결된 현장은 <b>안정 상태</b>입니다. 실시간 영상과 보호구 AI가 지속적으로 현장을 확인합니다.`;
  const points = [top ? `오늘 가장 많이 발생한 유형은 ‘${top[0]}’ ${top[1]}건입니다.` : "오늘 누적 이벤트가 없습니다.", `${s.online || 0}대의 현장 지킴이가 중앙 관제에 연결되어 있습니다.`, s.unacknowledged ? `확인이 필요한 이벤트가 ${s.unacknowledged}건 남아 있습니다.` : "모든 이벤트가 확인된 상태입니다."];
  $("#aiBriefing").innerHTML = `<div class="brief-main">${main}</div><div class="ai-points">${points.map((point) => `<div class="ai-point"><i></i><span>${escapeHtml(point)}</span></div>`).join("")}</div>`;
}

function updateDeviceSelects() {
  const options = state.devices.map((device) => `<option value="${escapeHtml(device.id)}">${escapeHtml(device.name)} · ${escapeHtml(device.area)}</option>`).join("");
  [$("#zoneDeviceSelect"), ...$$(".rule-device-select")].filter(Boolean).forEach((select) => {
    const before = select.value;
    select.innerHTML = options || `<option value="">장치 없음</option>`;
    if (state.devices.some((device) => device.id === before)) select.value = before;
  });
  const filter = $("#eventDeviceFilter");
  if (filter) {
    const before = filter.value;
    filter.innerHTML = `<option value="">전체 장치</option>${options}`;
    filter.value = before;
  }
}

async function acknowledgeEvent(id) {
  try {
    await api(`/api/events/${encodeURIComponent(id)}/ack`, { method: "POST", body: JSON.stringify({ status: "확인 완료" }) });
    toast("이벤트를 확인 완료 처리했습니다.");
    await loadDashboard(true);
  } catch (error) { toast(error.message); }
}

async function deleteDevice(id) {
  if (!confirm("장치와 관련 이벤트를 삭제하시겠습니까?")) return;
  try {
    await api(`/api/devices/${encodeURIComponent(id)}`, { method: "DELETE" });
    closeAdminSignal(id);
    await loadDashboard(true);
  } catch (error) { toast(error.message); }
}

async function simulateEvent() {
  try {
    await api("/api/demo/simulate", { method: "POST", body: "{}" });
    toast("시연용 위험 이벤트를 생성했습니다.");
    await loadDashboard(true);
  } catch (error) { toast(error.message); }
}

/* ---------- WebRTC signaling ---------- */

async function loadIceServers() {
  try {
    const result = await api("/api/ice");
    if (Array.isArray(result.iceServers) && result.iceServers.length) state.iceServers = result.iceServers;
  } catch { /* STUN default remains */ }
}

function websocketUrl(deviceId, role, clientId) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/api/realtime/${encodeURIComponent(deviceId)}?role=${encodeURIComponent(role)}&clientId=${encodeURIComponent(clientId)}`;
}

function createSignal(deviceId, role, onMessage) {
  const signal = {
    deviceId,
    role,
    clientId: uuid(role),
    ws: null,
    peers: new Map(),
    closed: false,
    reconnectTimer: null,
    send(message) {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
    },
    close() {
      this.closed = true;
      clearTimeout(this.reconnectTimer);
      try { this.ws?.close(1000, "closed"); } catch { /* noop */ }
    },
  };

  const connect = () => {
    if (signal.closed || !state.session) return;
    const ws = new WebSocket(websocketUrl(deviceId, role, signal.clientId));
    signal.ws = ws;
    ws.onopen = () => {
      signal.send({ type: "hello", deviceId, role });
      if (role === "admin" && shouldWatchDevice(deviceId)) setTimeout(() => requestWatch(deviceId, false, state.liveViewDeviceId === deviceId ? "high" : "low"), 100);
    };
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "connected" || message.type === "peers") {
          signal.peers.clear();
          for (const peer of message.peers || []) signal.peers.set(peer.clientId, peer);
        } else if (message.type === "peer-joined" && message.clientId) {
          signal.peers.set(message.clientId, { clientId: message.clientId, role: message.role });
        } else if (message.type === "peer-left" && message.clientId) {
          signal.peers.delete(message.clientId);
          cleanupPeer(deviceId, message.clientId);
        }
        onMessage(signal, message);
      } catch (error) { console.warn("signal message", error); }
    };
    ws.onclose = () => {
      if (!signal.closed && state.session) signal.reconnectTimer = setTimeout(connect, 2200);
    };
    ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
  };
  connect();
  return signal;
}

function reconcileAdminSignals() {
  if (state.session?.role !== "admin") return;
  const onlineIds = new Set(state.devices.filter((device) => device.status === "online").map((device) => device.id));
  for (const deviceId of onlineIds) {
    if (!realtime.adminSignals.has(deviceId)) {
      realtime.adminSignals.set(deviceId, createSignal(deviceId, "admin", handleAdminSignalMessage));
    }
  }
  for (const deviceId of realtime.adminSignals.keys()) {
    if (!onlineIds.has(deviceId)) closeAdminSignal(deviceId);
  }
  syncAdminWatchRequests();
}

function closeAdminSignal(deviceId) {
  realtime.adminSignals.get(deviceId)?.close();
  realtime.adminSignals.delete(deviceId);
  closeAdminVideoPeer(deviceId);
}

function closeAllAdminSignals() {
  for (const deviceId of [...realtime.adminSignals.keys()]) closeAdminSignal(deviceId);
}

function shouldWatchDevice(deviceId) {
  if (state.session?.role !== "admin") return false;
  if (state.liveViewDeviceId === deviceId) return true;
  if (!["overview", "live", "zones"].includes(state.currentPage)) return false;
  const online = state.devices.filter((device) => device.status === "online").slice(0, state.currentPage === "live" ? 6 : 4);
  return online.some((device) => device.id === deviceId);
}

function syncAdminWatchRequests() {
  for (const [deviceId, signal] of realtime.adminSignals) {
    if (shouldWatchDevice(deviceId)) requestWatch(deviceId, false, state.liveViewDeviceId === deviceId ? "high" : "low");
    else signal.send({ type: "watch-stop" });
  }
}

function requestWatch(deviceId, force = false, quality = "low") {
  const signal = realtime.adminSignals.get(deviceId);
  if (!signal) return;
  const record = realtime.adminVideoPeers.get(deviceId);
  const existing = record?.pc;
  const healthy = existing && ["new", "connecting", "connected"].includes(existing.connectionState);
  if (!force && healthy && record?.quality === quality) return;
  if (existing) closeAdminVideoPeer(deviceId);
  signal.send({ type: "watch-start", quality });
  $$(`.device-card[data-device-id="${CSS.escape(deviceId)}"] .connection-note`).forEach((element) => { element.textContent = "WebRTC 실시간 영상 연결 중"; element.hidden = false; });
  if (state.liveViewDeviceId === deviceId) attachLiveViewStream();
}

function createPeerConnection() {
  return new RTCPeerConnection({
    iceServers: state.iceServers,
    iceCandidatePoolSize: 4,
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require",
  });
}

async function configureVideoSender(sender, quality = "low") {
  if (!sender?.getParameters || !sender?.setParameters) return;
  try {
    const parameters = sender.getParameters();
    parameters.encodings ||= [{}];
    const high = quality === "high";
    parameters.encodings[0].maxBitrate = high ? 2_500_000 : 700_000;
    parameters.encodings[0].maxFramerate = high ? 30 : 18;
    parameters.encodings[0].scaleResolutionDownBy = high ? 1 : 1.5;
    parameters.degradationPreference = "maintain-framerate";
    await sender.setParameters(parameters);
  } catch (error) { console.warn("video sender tuning", error); }
}

function preferVideoCodecs(pc) {
  try {
    const capabilities = RTCRtpReceiver.getCapabilities?.("video");
    if (!capabilities?.codecs?.length) return;
    const preferred = [...capabilities.codecs].sort((a, b) => {
      const score = (codec) => /H264/i.test(codec.mimeType) ? 3 : /VP8/i.test(codec.mimeType) ? 2 : /VP9/i.test(codec.mimeType) ? 1 : 0;
      return score(b) - score(a);
    });
    for (const transceiver of pc.getTransceivers()) {
      if (transceiver.receiver?.track?.kind === "video" || transceiver.sender?.track?.kind === "video") transceiver.setCodecPreferences?.(preferred);
    }
  } catch { /* browser does not support codec preference */ }
}

function pcKey(channel, deviceId, peerId, callId = "") {
  return `${channel}:${deviceId}:${peerId}:${callId}`;
}

function queueIce(key, candidate) {
  if (!realtime.pendingIce.has(key)) realtime.pendingIce.set(key, []);
  realtime.pendingIce.get(key).push(candidate);
}

async function flushIce(key, pc) {
  const candidates = realtime.pendingIce.get(key) || [];
  realtime.pendingIce.delete(key);
  for (const candidate of candidates) {
    try { await pc.addIceCandidate(candidate); } catch { /* noop */ }
  }
}

async function handleAdminSignalMessage(signal, message) {
  if (message.type === "peer-joined" && message.role === "guard" && shouldWatchDevice(signal.deviceId)) signal.send({ type: "watch-start", quality: state.liveViewDeviceId === signal.deviceId ? "high" : "low", to: message.clientId });
  if (message.type === "offer" && message.channel === "video") await acceptAdminVideoOffer(signal, message);
  if (message.type === "ice" && message.channel === "video") await handleAdminVideoIce(signal, message);
  if (message.type === "stop-work-request") handleIncomingWorkStop(message);
  if (message.type === "stop-work-status") handleWorkStopStatus(message);
  if (message.type === "photo-analysis-ready") handlePhotoAnalysisSignal(message);
  if (["call-request", "call-accept", "call-reject", "call-offer", "call-answer", "call-ice", "call-end", "call-busy"].includes(message.type)) await handleCallSignal(signal, message);
}

async function acceptAdminVideoOffer(signal, message) {
  closeAdminVideoPeer(signal.deviceId);
  const pc = createPeerConnection();
  realtime.adminVideoPeers.set(signal.deviceId, { pc, peerId: message.from, quality: message.quality || (state.liveViewDeviceId === signal.deviceId ? "high" : "low") });
  const key = pcKey("video", signal.deviceId, message.from);
  pc.ontrack = (event) => {
    const stream = event.streams[0] || new MediaStream([event.track]);
    realtime.adminRemoteStreams.set(signal.deviceId, stream);
    attachStreamEverywhere(signal.deviceId);
    if (state.currentPage === "zones") drawZoneCanvas();
  };
  pc.onicecandidate = (event) => {
    if (event.candidate) signal.send({ type: "ice", channel: "video", candidate: event.candidate, to: message.from });
  };
  pc.onconnectionstatechange = () => {
    if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
      realtime.adminRemoteStreams.delete(signal.deviceId);
      attachStreamEverywhere(signal.deviceId);
      if (pc.connectionState !== "closed" && shouldWatchDevice(signal.deviceId)) {
        setTimeout(() => requestWatch(signal.deviceId, true, state.liveViewDeviceId === signal.deviceId ? "high" : "low"), 1500);
      }
    }
  };
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === "failed") {
      try { pc.restartIce(); } catch { /* noop */ }
    }
  };
  await pc.setRemoteDescription(message.description);
  await flushIce(key, pc);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  signal.send({ type: "answer", channel: "video", description: pc.localDescription, to: message.from });
}

async function handleAdminVideoIce(signal, message) {
  const record = realtime.adminVideoPeers.get(signal.deviceId);
  const key = pcKey("video", signal.deviceId, message.from);
  if (!record?.pc?.remoteDescription) queueIce(key, message.candidate);
  else try { await record.pc.addIceCandidate(message.candidate); } catch { /* noop */ }
}

function closeAdminVideoPeer(deviceId) {
  const record = realtime.adminVideoPeers.get(deviceId);
  try { record?.pc?.close(); } catch { /* noop */ }
  realtime.adminVideoPeers.delete(deviceId);
  realtime.adminRemoteStreams.delete(deviceId);
  attachStreamEverywhere(deviceId);
}

function cleanupPeer(deviceId, peerId) {
  const admin = realtime.adminVideoPeers.get(deviceId);
  if (admin?.peerId === peerId) closeAdminVideoPeer(deviceId);
  const guardPc = realtime.guardVideoPeers.get(peerId);
  if (guardPc) {
    try { guardPc.close(); } catch { /* noop */ }
    realtime.guardVideoPeers.delete(peerId);
    updateGuardViewerCount();
  }
  if (callState.peerId === peerId) endCall(false);
}

async function handleGuardSignalMessage(signal, message) {
  if (message.type === "watch-start" && message.from) await createGuardVideoOffer(signal, message.from, message.quality || "low");
  if (message.type === "watch-stop" && message.from) closeGuardVideoPeer(message.from);
  if (message.type === "answer" && message.channel === "video") await acceptGuardVideoAnswer(message);
  if (message.type === "ice" && message.channel === "video") await handleGuardVideoIce(message);
  if (message.type === "stop-work-status") handleWorkStopStatus(message);
  if (message.type === "photo-analysis-ready") handlePhotoAnalysisSignal(message);
  if (["call-request", "call-accept", "call-reject", "call-offer", "call-answer", "call-ice", "call-end", "call-busy"].includes(message.type)) await handleCallSignal(signal, message);
}

async function createGuardVideoOffer(signal, adminPeerId, quality = "low") {
  if (!guard.active || !guard.stream) return;
  const existing = realtime.guardVideoPeers.get(adminPeerId);
  if (existing && ["new", "connecting", "connected"].includes(existing.connectionState) && existing._ssgQuality === quality) return;
  closeGuardVideoPeer(adminPeerId);
  const pc = createPeerConnection();
  pc._ssgQuality = quality;
  realtime.guardVideoPeers.set(adminPeerId, pc);
  for (const track of guard.stream.getVideoTracks()) {
    track.contentHint = "motion";
    const sender = pc.addTrack(track, guard.stream);
    await configureVideoSender(sender, quality);
  }
  preferVideoCodecs(pc);
  const key = pcKey("video", getGuardDeviceId(), adminPeerId);
  pc.onicecandidate = (event) => {
    if (event.candidate) signal.send({ type: "ice", channel: "video", candidate: event.candidate, to: adminPeerId });
  };
  pc.onconnectionstatechange = () => {
    if (["failed", "disconnected", "closed"].includes(pc.connectionState)) closeGuardVideoPeer(adminPeerId);
    updateGuardViewerCount();
  };
  const offer = await pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false });
  await pc.setLocalDescription(offer);
  signal.send({ type: "offer", channel: "video", quality, description: pc.localDescription, to: adminPeerId });
  updateGuardViewerCount();
}

async function acceptGuardVideoAnswer(message) {
  const pc = realtime.guardVideoPeers.get(message.from);
  if (!pc) return;
  await pc.setRemoteDescription(message.description);
  await flushIce(pcKey("video", getGuardDeviceId(), message.from), pc);
}

async function handleGuardVideoIce(message) {
  const pc = realtime.guardVideoPeers.get(message.from);
  const key = pcKey("video", getGuardDeviceId(), message.from);
  if (!pc?.remoteDescription) queueIce(key, message.candidate);
  else try { await pc.addIceCandidate(message.candidate); } catch { /* noop */ }
}

function closeGuardVideoPeer(peerId) {
  const pc = realtime.guardVideoPeers.get(peerId);
  try { pc?.close(); } catch { /* noop */ }
  realtime.guardVideoPeers.delete(peerId);
  updateGuardViewerCount();
}

function updateGuardViewerCount() {
  guard.viewerCount = [...realtime.guardVideoPeers.values()].filter((pc) => ["connected", "connecting", "new"].includes(pc.connectionState)).length;
  $("#guardViewerMetric").textContent = `${guard.viewerCount}명 연결`;
}

/* ---------- Two-way radio ---------- */

function unlockAudio() {
  try {
    callState.audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    callState.audioContext.resume().catch(() => {});
  } catch { /* noop */ }
}

function beep(frequency = 880, duration = 0.16, volume = 0.08) {
  unlockAudio();
  const context = callState.audioContext;
  if (!context) return;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.value = frequency;
  gain.gain.value = volume;
  oscillator.connect(gain).connect(context.destination);
  oscillator.start();
  gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + duration);
  oscillator.stop(context.currentTime + duration);
}

function startRinging() {
  stopRinging();
  beep(880, .18, .1);
  callState.ringTimer = setInterval(() => {
    beep(880, .16, .08);
    setTimeout(() => beep(1120, .16, .07), 220);
  }, 1200);
}

function stopRinging() {
  clearInterval(callState.ringTimer);
  callState.ringTimer = null;
}

function setCallStatus(text) {
  $("#callConnectionStatus").textContent = text;
}

function showCallModal(mode, title, description) {
  $("#callModal").hidden = false;
  $("#callTitle").textContent = title;
  $("#callDescription").textContent = description;
  $("#incomingCallActions").hidden = mode !== "incoming";
  $("#activeCallActions").hidden = mode !== "active";
  $("#callOrb").className = `call-orb ${mode === "incoming" || mode === "outgoing" ? "ringing" : mode === "active" ? "connected" : ""}`;
  setCallStatus(mode === "incoming" ? "호출 수신" : mode === "outgoing" ? "연결 중" : mode === "active" ? "통화 연결됨" : "대기");
}

function hideCallModal() {
  $("#callModal").hidden = true;
  $("#floatingCallAlert").hidden = true;
}

function findPeer(signal, role) {
  return [...signal.peers.values()].find((peer) => peer.role === role)?.clientId || null;
}

async function initiateAdminCall(deviceId) {
  const signal = realtime.adminSignals.get(deviceId);
  if (!signal) return toast("현장 장치가 온라인 상태가 아닙니다.");
  const peerId = findPeer(signal, "guard");
  if (!peerId) return toast("현장 지킴이 연결을 찾지 못했습니다.");
  await beginOutgoingCall(signal, peerId, deviceId, state.devices.find((item) => item.id === deviceId)?.name || "현장 장치");
}

async function initiateGuardCall() {
  const signal = guard.signal;
  if (!signal) return toast("관제 서버 연결이 필요합니다.");
  const peerId = findPeer(signal, "admin");
  if (!peerId) return toast("현재 접속 중인 관리자가 없습니다.");
  await beginOutgoingCall(signal, peerId, getGuardDeviceId(), "관제센터");
}

async function beginOutgoingCall(signal, peerId, deviceId, targetName) {
  if (callState.status !== "idle") return toast("이미 다른 무전 통화가 진행 중입니다.");
  try {
    unlockAudio();
    await ensureCallMicrophone();
  } catch (error) {
    return toast(`마이크를 사용할 수 없습니다: ${error.message}`);
  }
  callState.status = "outgoing";
  callState.direction = "outgoing";
  callState.signal = signal;
  callState.peerId = peerId;
  callState.deviceId = deviceId;
  callState.callId = uuid("call");
  callState.muted = false;
  callState.localTrack.enabled = true;
  updateCallMicUi();
  signal.send({ type: "call-request", to: peerId, callId: callState.callId, deviceId });
  startRinging();
  showCallModal("outgoing", `${targetName} 호출 중`, "상대방이 응답하면 양방향 음성 통화가 연결됩니다.");
  clearTimeout(callState.timeoutTimer);
  callState.timeoutTimer = setTimeout(() => {
    if (["outgoing", "connecting"].includes(callState.status)) {
      toast("무전 연결 시간이 초과되었습니다.");
      endCall(true);
    }
  }, 35000);
}

async function handleCallSignal(signal, message) {
  if (message.type === "call-request") {
    if (callState.status !== "idle") {
      signal.send({ type: "call-busy", to: message.from, callId: message.callId });
      return;
    }
    callState.status = "incoming";
    callState.direction = "incoming";
    callState.signal = signal;
    callState.peerId = message.from;
    callState.deviceId = signal.deviceId;
    callState.callId = message.callId;
    const deviceName = state.devices.find((item) => item.id === signal.deviceId)?.name || (state.session?.role === "user" ? "관제센터" : "현장 지킴이");
    startRinging();
    showCallModal("incoming", `${deviceName} 무전 호출`, "호출이 도착했습니다. 응답하면 양방향 음성 통화가 연결됩니다.");
    $("#floatingCallTitle").textContent = `${deviceName} 호출 수신`;
    $("#floatingCallText").textContent = "무전 통화 응답이 필요합니다.";
    $("#floatingCallAlert").hidden = false;
    if (document.hidden && "Notification" in window && Notification.permission === "granted") {
      new Notification("스마트 안전지킴이 무전 호출", { body: `${deviceName}에서 연락이 왔습니다.` });
    }
    return;
  }
  if (message.callId && callState.callId && message.callId !== callState.callId) return;
  if (message.type === "call-accept" && callState.status === "outgoing") {
    stopRinging();
    callState.status = "connecting";
    await createCallOffer();
  } else if (["call-reject", "call-busy"].includes(message.type)) {
    toast(message.type === "call-busy" ? "상대방이 다른 통화 중입니다." : "상대방이 호출을 거절했습니다.");
    endCall(false);
  } else if (message.type === "call-offer") {
    await receiveCallOffer(message);
  } else if (message.type === "call-answer") {
    if (callState.pc) {
      await callState.pc.setRemoteDescription(message.description);
      await flushIce(pcKey("call", callState.deviceId, callState.peerId, callState.callId), callState.pc);
      setCallStatus("음성 연결 확인 중");
    }
  } else if (message.type === "call-ice") {
    const key = pcKey("call", callState.deviceId, message.from, message.callId);
    if (!callState.pc?.remoteDescription) queueIce(key, message.candidate);
    else try { await callState.pc.addIceCandidate(message.candidate); } catch { /* noop */ }
  } else if (message.type === "call-end") {
    toast("무전 통화가 종료되었습니다.");
    endCall(false);
  }
}

async function ensureCallMicrophone() {
  if (callState.localTrack?.readyState === "live") return;
  callState.localStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    video: false,
  });
  callState.localTrack = callState.localStream.getAudioTracks()[0];
  if (!callState.localTrack) throw new Error("사용 가능한 마이크를 찾지 못했습니다.");
  callState.localTrack.enabled = true;
}

function buildCallPeer() {
  const pc = createPeerConnection();
  callState.pc = pc;
  if (callState.localTrack) pc.addTrack(callState.localTrack, callState.localStream);
  pc.onicecandidate = (event) => {
    if (event.candidate) callState.signal?.send({ type: "call-ice", channel: "call", callId: callState.callId, candidate: event.candidate, to: callState.peerId });
  };
  pc.ontrack = async (event) => {
    callState.remoteStream = event.streams[0] || new MediaStream([event.track]);
    const audio = $("#remoteCallAudio");
    audio.srcObject = callState.remoteStream;
    audio.muted = false;
    audio.volume = 1;
    setCallConnected();
    await playRemoteCallAudio();
  };
  pc.onconnectionstatechange = () => {
    setCallStatus(`통화 상태: ${pc.connectionState}`);
    if (pc.connectionState === "connected") setCallConnected();
    if (["failed", "closed"].includes(pc.connectionState)) {
      toast(pc.connectionState === "failed" ? "음성 연결에 실패했습니다. 같은 Wi-Fi 또는 TURN 설정을 확인해주세요." : "무전 통화가 종료되었습니다.");
      endCall(false);
    }
  };
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === "disconnected") setCallStatus("음성 연결 복구 중");
    if (pc.iceConnectionState === "failed") {
      try { pc.restartIce(); } catch { /* noop */ }
    }
  };
  return pc;
}

async function playRemoteCallAudio() {
  const audio = $("#remoteCallAudio");
  if (!audio.srcObject) return false;
  try {
    audio.muted = false;
    audio.volume = 1;
    await audio.play();
    callState.remotePlaybackBlocked = false;
    $("#remoteAudioPlayButton").hidden = true;
    return true;
  } catch {
    callState.remotePlaybackBlocked = true;
    $("#remoteAudioPlayButton").hidden = false;
    setCallStatus("상대방 소리 재생 버튼을 눌러주세요");
    return false;
  }
}

async function createCallOffer() {
  const pc = buildCallPeer();
  const offer = await pc.createOffer({ offerToReceiveAudio: true });
  await pc.setLocalDescription(offer);
  callState.signal.send({ type: "call-offer", channel: "call", callId: callState.callId, description: pc.localDescription, to: callState.peerId });
  showCallModal("outgoing", "무전 연결 중", "음성 채널을 연결하고 있습니다.");
}

async function receiveCallOffer(message) {
  callState.status = "connecting";
  await ensureCallMicrophone();
  callState.localTrack.enabled = true;
  callState.muted = false;
  const pc = buildCallPeer();
  await pc.setRemoteDescription(message.description);
  await flushIce(pcKey("call", callState.deviceId, message.from, callState.callId), pc);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  callState.signal.send({ type: "call-answer", channel: "call", callId: callState.callId, description: pc.localDescription, to: message.from });
  setCallStatus("음성 연결 확인 중");
}

async function acceptIncomingCall() {
  if (callState.status !== "incoming") return;
  stopRinging();
  try {
    unlockAudio();
    await ensureCallMicrophone();
    callState.localTrack.enabled = true;
    callState.muted = false;
    updateCallMicUi();
    callState.status = "connecting";
    callState.signal.send({ type: "call-accept", to: callState.peerId, callId: callState.callId });
    showCallModal("outgoing", "무전 연결 중", "상대방의 음성 채널을 기다리고 있습니다.");
  } catch (error) {
    toast(`마이크를 사용할 수 없습니다: ${error.message}`);
    callState.signal.send({ type: "call-reject", to: callState.peerId, callId: callState.callId });
    endCall(false);
  }
}

function rejectIncomingCall() {
  callState.signal?.send({ type: "call-reject", to: callState.peerId, callId: callState.callId });
  endCall(false);
}

function setCallConnected() {
  if (callState.status === "connected") return;
  callState.status = "connected";
  clearTimeout(callState.timeoutTimer);
  stopRinging();
  if (callState.localTrack) callState.localTrack.enabled = !callState.muted;
  updateCallMicUi();
  showCallModal("active", "무전 통화 연결됨", "양쪽 마이크가 연결되었습니다. 버튼을 눌러 내 마이크를 음소거할 수 있습니다.");
  $("#floatingCallAlert").hidden = true;
  $("#guardRadioIndicator").textContent = "통화 중";
  $("#guardRadioIndicator").classList.add("active");
  beep(1320, .12, .06);
  playRemoteCallAudio();
}

function updateCallMicUi() {
  const button = $("#pttButton");
  const active = !callState.muted;
  button.classList.toggle("transmitting", active);
  button.classList.toggle("muted", !active);
  $("b", button).textContent = active ? "마이크 켜짐" : "마이크 음소거";
  $("small", button).textContent = active ? "클릭하면 내 마이크를 끕니다." : "클릭하면 내 마이크를 켭니다.";
}

function toggleCallMic() {
  if (callState.status !== "connected" || !callState.localTrack) return;
  callState.muted = !callState.muted;
  callState.localTrack.enabled = !callState.muted;
  updateCallMicUi();
  setCallStatus(callState.muted ? "내 마이크 음소거" : "양방향 음성 연결됨");
}

function endCall(notify = true) {
  if (notify && callState.signal && callState.peerId && callState.callId) callState.signal.send({ type: "call-end", to: callState.peerId, callId: callState.callId });
  clearTimeout(callState.timeoutTimer);
  stopRinging();
  try { callState.pc?.close(); } catch { /* noop */ }
  callState.localStream?.getTracks().forEach((track) => track.stop());
  Object.assign(callState, { status: "idle", direction: null, deviceId: null, peerId: null, signal: null, callId: null, pc: null, localStream: null, localTrack: null, remoteStream: null, muted: false, remotePlaybackBlocked: false });
  const audio = $("#remoteCallAudio");
  audio.pause();
  audio.srcObject = null;
  $("#remoteAudioPlayButton").hidden = true;
  $("#guardRadioIndicator").textContent = "대기";
  $("#guardRadioIndicator").classList.remove("active");
  setCallStatus("대기");
  hideCallModal();
}

/* ---------- Field guard ---------- */

function getGuardDeviceId() {
  let id = localStorage.getItem("ssg-device-id");
  if (!id) {
    id = `${isMobile() ? "mobile" : "browser"}-${crypto.randomUUID().slice(0, 12)}`;
    localStorage.setItem("ssg-device-id", id);
  }
  return id;
}

function loadGuardProfile() {
  const saved = JSON.parse(localStorage.getItem("ssg-guard-profile") || "{}");
  $("#guardDeviceId").textContent = getGuardDeviceId();
  $("#guardDeviceName").value = saved.name || (isMobile() ? "휴대폰 지킴이" : "노트북 지킴이");
  $("#guardSite").value = saved.site || "POSCO Future M 시연 현장";
  $("#guardArea").value = saved.area || "안전 시연구역";
  $("#guardVoiceEnabled").checked = saved.voiceEnabled !== false;
  $("#guardZoneEnabled").checked = saved.zoneEnabled !== false;
  updateGuardAlarmUi();
}

function updateGuardAlarmUi() {
  const enabled = $("#guardVoiceEnabled").checked;
  const button = $("#guardAlarmButton");
  button.textContent = enabled ? "🔊 알람 켜짐" : "🔇 알람 꺼짐";
  button.classList.toggle("alarm-muted", !enabled);
  button.setAttribute("aria-pressed", String(!enabled));
}

function stopSafetyAlerts() {
  guard.voiceQueue = [];
  guard.voiceSpeaking = false;
  guard.currentVoiceText = null;
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  $("#guardWarningBanner").classList.remove("show");
}

function toggleGuardAlarm() {
  $("#guardVoiceEnabled").checked = !$("#guardVoiceEnabled").checked;
  if (!$("#guardVoiceEnabled").checked) stopSafetyAlerts();
  updateGuardAlarmUi();
  saveGuardProfile(false);
  toast($("#guardVoiceEnabled").checked ? "안전 알람을 켰습니다." : "안전 알람을 껐습니다. 화면 경고와 이벤트 기록은 계속됩니다.");
}

function saveGuardProfile(showToast = true) {
  localStorage.setItem("ssg-guard-profile", JSON.stringify({
    name: $("#guardDeviceName").value.trim(),
    site: $("#guardSite").value.trim(),
    area: $("#guardArea").value.trim(),
    cameraId: $("#guardCameraSelect").value,
    voiceEnabled: $("#guardVoiceEnabled").checked,
    zoneEnabled: $("#guardZoneEnabled").checked,
  }));
  if (showToast) toast("장치 정보를 저장했습니다.");
  updateGuardAlarmUi();
  if (guard.active) registerGuard();
}

function guardConstraints() {
  const cameraId = $("#guardCameraSelect").value || JSON.parse(localStorage.getItem("ssg-guard-profile") || "{}").cameraId;
  const video = cameraId
    ? { deviceId: { exact: cameraId }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } }
    : { facingMode: isMobile() ? { ideal: "environment" } : "user", width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } };
  return { video, audio: false };
}

async function startGuard() {
  if (guard.active || guard.starting) return;
  if (!navigator.mediaDevices?.getUserMedia) return toast("이 브라우저에서는 카메라 기능을 사용할 수 없습니다.");
  guard.starting = true;
  updateGuardUi();
  try {
    unlockAudio();
    const stream = await navigator.mediaDevices.getUserMedia(guardConstraints());
    guard.stream = stream;
    const video = $("#guardVideo");
    video.srcObject = stream;
    await video.play();
    await enumerateCameras();
    resizeGuardOverlay();
    guard.active = true;
    guard.starting = false;
    guard.currentRisk = "정상";
    await registerGuard();
    await fetchGuardConfig();
    await loadActiveTbm();
    guard.signal = createSignal(getGuardDeviceId(), "guard", handleGuardSignalMessage);
    startGuardWorker();
    startGuardTimers();
    updateGuardUi();
    setTimeout(uploadGuardPreview, 1200);
    toast("스마트 안전지킴이가 시작되었습니다.");
  } catch (error) {
    guard.starting = false;
    guard.active = false;
    updateGuardUi();
    toast(`카메라를 시작할 수 없습니다: ${error.message}`);
  }
}

async function stopGuard() {
  guard.active = false;
  guard.starting = false;
  stopGuardTimers();
  guard.signal?.close();
  guard.signal = null;
  for (const peerId of [...realtime.guardVideoPeers.keys()]) closeGuardVideoPeer(peerId);
  guard.worker?.terminate();
  guard.worker = null;
  guard.modelReady = false;
  guard.stream?.getTracks().forEach((track) => track.stop());
  guard.stream = null;
  $("#guardVideo").srcObject = null;
  clearGuardOverlay();
  try { await api("/api/agents/offline", { method: "POST", body: JSON.stringify({ deviceId: getGuardDeviceId() }) }); } catch { /* noop */ }
  updateGuardUi();
}

async function toggleGuard() {
  if (guard.active || guard.starting) await stopGuard();
  else await startGuard();
}

function updateGuardUi() {
  const active = guard.active;
  const starting = guard.starting;
  const label = starting ? "시작 중" : active ? "지킴이 종료" : "지킴이 시작";
  $("#guardStartButton").textContent = label;
  $("#guardTopButton b").textContent = label;
  $("#guardStartButton").disabled = starting;
  $("#guardTopButton").disabled = starting;
  $("#guardCameraPlaceholder").hidden = active;
  $("#guardLiveBadge").style.display = active ? "block" : "none";
  $("#guardStatusPill").classList.toggle("online", active);
  $("#guardStatusPill b").textContent = active ? "관제 연결" : starting ? "시작 중" : "대기 중";
  $("#guardConnectionMetric").textContent = active ? "ONLINE" : "OFFLINE";
  $("#guardModelMetric").textContent = guard.modelReady ? "PPE ON" : guard.modelError ? "모델 오류" : active ? "준비 중" : "대기";
  $("#guardPeopleMetric").textContent = `${guard.peopleCount}명`;
  $("#guardFpsMetric").textContent = `${guard.inferenceFps.toFixed(1)} FPS`;
  updateGuardViewerCount();
}

async function enumerateCameras() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const select = $("#guardCameraSelect");
  const before = select.value;
  const cameras = devices.filter((device) => device.kind === "videoinput");
  select.innerHTML = cameras.map((camera, index) => `<option value="${escapeHtml(camera.deviceId)}">${escapeHtml(camera.label || `카메라 ${index + 1}`)}</option>`).join("") || `<option value="">기본 카메라</option>`;
  if (cameras.some((camera) => camera.deviceId === before)) select.value = before;
}

async function restartGuardCamera() {
  if (!guard.active) return saveGuardProfile();
  await stopGuard();
  await sleep(250);
  await startGuard();
}

async function registerGuard() {
  const profile = {
    name: $("#guardDeviceName").value.trim() || "현장 지킴이",
    site: $("#guardSite").value.trim() || "미지정 사업장",
    area: $("#guardArea").value.trim() || "미지정 구역",
  };
  localStorage.setItem("ssg-guard-profile", JSON.stringify({ ...profile, cameraId: $("#guardCameraSelect").value, voiceEnabled: $("#guardVoiceEnabled").checked, zoneEnabled: $("#guardZoneEnabled").checked }));
  await api("/api/agents/register", { method: "POST", body: JSON.stringify({ deviceId: getGuardDeviceId(), ...profile, cameraLabel: $("#guardCameraSelect").selectedOptions[0]?.textContent || "브라우저 카메라", agentVersion: "browser-webrtc-4.0", config: guard.config }) });
}

async function fetchGuardConfig() {
  if (!guard.active) return;
  try {
    guard.config = await api(`/api/devices/${encodeURIComponent(getGuardDeviceId())}/config`);
    drawGuardOverlay(guard.detections, 0, 0);
    updateGuardAlarmUi();
  } catch { /* first registration race */ }
}

function startGuardTimers() {
  stopGuardTimers();
  guard.heartbeatTimer = setInterval(sendGuardHeartbeat, 10000);
  guard.configTimer = setInterval(fetchGuardConfig, 15000);
  guard.previewTimer = setInterval(uploadGuardPreview, 30000);
  guard.tbmTimer = setInterval(loadActiveTbm, 60000);
}

function stopGuardTimers() {
  ["heartbeatTimer", "configTimer", "previewTimer", "tbmTimer", "inferenceTimer"].forEach((key) => { clearInterval(guard[key]); clearTimeout(guard[key]); guard[key] = null; });
}

async function sendGuardHeartbeat() {
  if (!guard.active) return;
  try {
    await api("/api/agents/heartbeat", { method: "POST", body: JSON.stringify({ deviceId: getGuardDeviceId(), fps: guard.inferenceFps, cpu: 0, memory: 0, peopleCount: guard.peopleCount, currentRisk: guard.currentRisk, agentVersion: "browser-webrtc-4.0" }) });
  } catch { /* reconnect will retry */ }
}

function startGuardWorker() {
  guard.worker?.terminate();
  guard.worker = new Worker("/ppe-worker.js");
  guard.modelReady = false;
  guard.modelError = null;
  $("#ppeLoading").hidden = false;
  guard.worker.onmessage = (event) => handlePpeWorkerMessage(event.data || {});
  guard.worker.onerror = (event) => {
    guard.modelError = event.message || "보호구 AI 오류";
    $("#ppeLoadingText").textContent = guard.modelError;
    updateGuardUi();
  };
  guard.worker.postMessage({ type: "load" });
}

function handlePpeWorkerMessage(message) {
  if (message.type === "model-status") {
    $("#ppeLoadingText").textContent = message.message;
  } else if (message.type === "model-progress") {
    const percent = message.percent || 0;
    $("#ppeLoading").style.setProperty("--model-progress", `${percent}%`);
    $("#ppeLoadingProgress").textContent = message.total ? `${percent}%` : `${Math.round((message.loaded || 0) / 1048576)}MB`;
  } else if (message.type === "model-ready") {
    guard.modelReady = true;
    $("#ppeLoading").style.setProperty("--model-progress", "100%");
    $("#ppeLoadingText").textContent = "보호구 AI 준비 완료";
    $("#ppeLoadingProgress").textContent = "100%";
    setTimeout(() => { $("#ppeLoading").hidden = true; }, 900);
    updateGuardUi();
    scheduleGuardInference(100);
  } else if (message.type === "model-error") {
    guard.modelError = message.message;
    $("#ppeLoadingText").textContent = "보호구 AI를 불러오지 못했습니다.";
    $("#ppeLoadingProgress").textContent = "재시도 필요";
    toast(message.message, 6000);
    updateGuardUi();
  } else if (message.type === "result") {
    guard.inferenceBusy = false;
    guard.detections = message.detections || [];
    guard.inferenceFps = message.inferenceMs ? 1000 / message.inferenceMs : 0;
    processGuardDetections(message);
    scheduleGuardInference(isMobile() ? 1500 : Math.max(750, guard.config.detection?.intervalMs || 1000));
  } else if (message.type === "inference-error") {
    guard.inferenceBusy = false;
    console.warn(message.message);
    scheduleGuardInference(1800);
  }
}

function scheduleGuardInference(delay) {
  clearTimeout(guard.inferenceTimer);
  if (!guard.active || !guard.modelReady) return;
  guard.inferenceTimer = setTimeout(runGuardInference, delay);
}

async function runGuardInference() {
  if (!guard.active || !guard.modelReady || guard.inferenceBusy) return;
  const video = $("#guardVideo");
  if (video.readyState < 2 || !video.videoWidth) return scheduleGuardInference(400);
  guard.inferenceBusy = true;
  try {
    const bitmap = await createImageBitmap(video);
    guard.worker.postMessage({ type: "infer", requestId: Date.now(), bitmap, threshold: guard.config.detection?.confidence || 0.31 }, [bitmap]);
  } catch {
    guard.inferenceBusy = false;
    scheduleGuardInference(900);
  }
}

function resizeGuardOverlay() {
  const video = $("#guardVideo");
  const canvas = $("#guardOverlay");
  if (!video.videoWidth) return;
  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }
}

function clearGuardOverlay() {
  const canvas = $("#guardOverlay");
  canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
}

function centerInRect(item, rect) {
  const cx = item.x + item.width / 2;
  const cy = item.y + item.height / 2;
  return cx >= rect.x && cx <= rect.x + rect.width && cy >= rect.y && cy <= rect.y + rect.height;
}

function ppeRegionForPerson(person, type) {
  const expandX = person.width * 0.08;
  const x = Math.max(0, person.x - expandX);
  const width = person.width + expandX * 2;
  if (type === "helmet") return { x, y: Math.max(0, person.y - person.height * 0.05), width, height: person.height * 0.34 };
  if (type === "goggles") return { x: person.x + person.width * 0.12, y: person.y + person.height * 0.08, width: person.width * 0.76, height: person.height * 0.24 };
  return { x: person.x + person.width * 0.12, y: person.y + person.height * 0.20, width: person.width * 0.76, height: person.height * 0.25 };
}

function deriveMissingPpeDetections(detections, sourceHeight) {
  const result = [...detections];
  const people = detections.filter((item) => item.label === "Person");
  const definitions = [
    { type: "helmet", positive: "Hardhat", negative: "NO-Hardhat" },
    { type: "goggles", positive: "Goggles", negative: "NO-Goggles" },
    { type: "mask", positive: "Mask", negative: "NO-Mask" },
  ];
  const minRatio = guard.config.detection?.minPersonHeightRatio ?? 0.20;
  if (guard.config.detection?.inferMissingPpeFromPerson === false) return result;
  for (const person of people) {
    if (!sourceHeight || person.height / sourceHeight < minRatio || person.score < 0.40) continue;
    for (const definition of definitions) {
      const region = ppeRegionForPerson(person, definition.type);
      const personRect = { x: person.x, y: person.y, width: person.width, height: person.height };
      const directNegative = detections.some((item) => item.label === definition.negative && centerInRect(item, personRect));
      const positive = detections.some((item) => item.label === definition.positive && centerInRect(item, region));
      if (!directNegative && !positive) {
        result.push({
          classId: -1,
          label: definition.negative,
          score: Math.max(0.51, person.score * 0.72),
          x: region.x,
          y: region.y,
          width: region.width,
          height: region.height,
          x1: region.x,
          y1: region.y,
          x2: region.x + region.width,
          y2: region.y + region.height,
          synthetic: true,
        });
      }
    }
  }
  return result;
}

function processGuardDetections(message) {
  resizeGuardOverlay();
  const rawDetections = message.detections || [];
  const detections = deriveMissingPpeDetections(rawDetections, message.sourceHeight);
  guard.peopleCount = rawDetections.filter((item) => item.label === "Person").length;
  const violations = [];
  const rules = guard.config.rules || {};
  const noHelmet = detections.filter((item) => item.label === "NO-Hardhat");
  const noGoggles = detections.filter((item) => item.label === "NO-Goggles");
  const noMask = detections.filter((item) => item.label === "NO-Mask");
  const noHarness = detections.filter((item) => item.label === "No_Harness");
  const falls = detections.filter((item) => item.label === "Fall-Detected");
  const zoneEntries = rules.dangerZone === true && $("#guardZoneEnabled").checked
    ? detectZoneEntries(rawDetections.filter((item) => item.label === "Person"), message.sourceWidth, message.sourceHeight)
    : [];

  if (rules.helmet !== false && noHelmet.length) violations.push(["helmet", { type: "HELMET_NOT_DETECTED", category: "보호구", severity: "high", message: "안전모 미착용 의심 상황이 감지되었습니다.", voice: "안전모를 착용해주세요.", metadata: { count: noHelmet.length } }]);
  if (rules.safetyGlasses !== false && noGoggles.length) violations.push(["goggles", { type: "SAFETY_GLASSES_NOT_DETECTED", category: "보호구", severity: "medium", message: "보안경 미착용 의심 상황이 감지되었습니다.", voice: "보안경을 착용해주세요.", metadata: { count: noGoggles.length } }]);
  if (rules.mask !== false && noMask.length) violations.push(["mask", { type: "MASK_NOT_DETECTED", category: "보호구", severity: "medium", message: "마스크 미착용 의심 상황이 감지되었습니다.", voice: "마스크를 착용해주세요.", metadata: { count: noMask.length } }]);
  if (rules.harness && noHarness.length) violations.push(["harness", { type: "HARNESS_NOT_DETECTED", category: "보호구", severity: "high", message: "안전대 미착용 의심 상황이 감지되었습니다.", voice: "안전대를 착용해주세요.", metadata: { count: noHarness.length } }]);
  if (rules.fall !== false && falls.length) violations.push(["fall", { type: "FALL_CANDIDATE", category: "불안전 행동", severity: "critical", message: "넘어짐 의심 상황이 감지되었습니다.", voice: "넘어짐 위험이 감지되었습니다. 확인해주세요.", metadata: { count: falls.length } }]);
  if (zoneEntries.length) violations.push(["zone", { type: "DANGER_ZONE_ENTRY", category: "위험구역", severity: "high", message: `${zoneEntries[0].zone.name}에 작업자가 진입했습니다.`, voice: "위험구역입니다. 즉시 이동해주세요.", metadata: { count: zoneEntries.length, zone: zoneEntries[0].zone.name } }]);

  const presentKeys = new Set(violations.map(([key]) => key));
  for (const key of ["helmet", "goggles", "mask", "harness", "fall", "zone"]) {
    if (!presentKeys.has(key)) guard.streaks.set(key, 0);
  }
  for (const [key, event] of violations) confirmViolation(key, event);
  guard.currentRisk = violations.length ? "위험" : "정상";
  guard.detections = detections;
  drawGuardOverlay(detections, message.sourceWidth, message.sourceHeight, zoneEntries);
  updateGuardUi();
}

function confirmViolation(key, event) {
  const streak = (guard.streaks.get(key) || 0) + 1;
  guard.streaks.set(key, streak);
  const required = guard.config.detection?.consecutiveFrames || 3;
  const now = Date.now();
  const cooldown = (guard.config.voice?.cooldownSeconds || 12) * 1000;
  if (streak >= required && now - (guard.lastEvents.get(key) || 0) >= cooldown) {
    guard.lastEvents.set(key, now);
    triggerGuardEvent(event);
  }
}

function detectZoneEntries(persons, sourceWidth, sourceHeight) {
  const zones = (guard.config.zones || []).filter((zone) => zone.enabled !== false && Array.isArray(zone.points) && zone.points.length >= 3);
  const entries = [];
  for (const person of persons) {
    const foot = [((person.x + person.width / 2) / sourceWidth), ((person.y + person.height) / sourceHeight)];
    for (const zone of zones) if (pointInPolygon(foot, zone.points)) entries.push({ person, zone, foot });
  }
  return entries;
}

function pointInPolygon(point, polygon) {
  let inside = false;
  const [x, y] = point;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersect = ((yi > y) !== (yj > y)) && x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-9) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function drawGuardOverlay(detections = [], sourceWidth = 0, sourceHeight = 0, zoneEntries = []) {
  const canvas = $("#guardOverlay");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const zoneEnabled = guard.config.rules?.dangerZone === true && $("#guardZoneEnabled").checked;
  const zones = zoneEnabled ? (guard.config.zones || []).filter((zone) => zone.enabled !== false && Array.isArray(zone.points) && zone.points.length >= 3) : [];
  for (const zone of zones) {
    ctx.beginPath();
    zone.points.forEach(([x, y], index) => index ? ctx.lineTo(x * canvas.width, y * canvas.height) : ctx.moveTo(x * canvas.width, y * canvas.height));
    ctx.closePath();
    ctx.fillStyle = "rgba(255,55,82,.10)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,55,82,.85)";
    ctx.lineWidth = 3;
    ctx.stroke();
    const [firstX, firstY] = zone.points[0] || [0, 0];
    drawLabel(ctx, zone.name || "DANGER ZONE", firstX * canvas.width, firstY * canvas.height, "#ff3c58", "#16080c");
  }
  if (!sourceWidth || !sourceHeight) return;
  const scaleX = canvas.width / sourceWidth;
  const scaleY = canvas.height / sourceHeight;
  for (const item of detections) {
    const style = detectionStyle(item.label);
    if (!style.show) continue;
    const x = item.x * scaleX;
    const y = item.y * scaleY;
    const width = item.width * scaleX;
    const height = item.height * scaleY;
    ctx.strokeStyle = style.color;
    ctx.lineWidth = style.lineWidth;
    ctx.setLineDash(item.synthetic ? [9, 6] : []);
    ctx.strokeRect(x, y, width, height);
    ctx.setLineDash([]);
    drawLabel(ctx, `${style.text} ${Math.round(item.score * 100)}%${item.synthetic ? " CHECK" : ""}`, x, Math.max(2, y - 23), style.color, style.background);
  }
  for (const entry of zoneEntries) {
    ctx.beginPath();
    ctx.arc(entry.foot[0] * canvas.width, entry.foot[1] * canvas.height, 8, 0, Math.PI * 2);
    ctx.fillStyle = "#ff3c58";
    ctx.fill();
  }
}

function detectionStyle(label) {
  const styles = {
    Hardhat: ["HAT: OK", "#5cff91", "#06180e", 3],
    "NO-Hardhat": ["HAT: NF", "#ff3c58", "#22070c", 4],
    Goggles: ["GOG: OK", "#5cff91", "#06180e", 3],
    "NO-Goggles": ["GOG: NF", "#ff3c58", "#22070c", 4],
    Mask: ["MASK: OK", "#5cff91", "#06180e", 3],
    "NO-Mask": ["MASK: NF", "#ff3c58", "#22070c", 4],
    No_Harness: ["HARNESS: NF", "#ff3c58", "#22070c", 4],
    "Fall-Detected": ["FALL: CHECK", "#ff3c58", "#22070c", 4],
    Person: ["PERSON", "#59e0dc", "#06181c", 2],
  };
  const value = styles[label];
  return value ? { show: true, text: value[0], color: value[1], background: value[2], lineWidth: value[3] } : { show: false };
}

function drawLabel(ctx, text, x, y, color, background) {
  ctx.font = `700 ${Math.max(13, Math.round(ctx.canvas.width / 70))}px "Nanum Barun Gothic", sans-serif`;
  const paddingX = 7;
  const height = 23;
  const width = ctx.measureText(text).width + paddingX * 2;
  ctx.fillStyle = background;
  ctx.fillRect(x, y, width, height);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, width, height);
  ctx.fillStyle = color;
  ctx.fillText(text, x + paddingX, y + 17);
}

async function triggerGuardEvent(event) {
  if (!guard.active) return;
  showGuardWarning(event.voice || event.message);
  if ($("#guardVoiceEnabled").checked && guard.config.voice?.enabled !== false) speak(event.voice || event.message);
  const snapshotBase64 = captureGuardSnapshot();
  try {
    await api("/api/agents/event", { method: "POST", body: JSON.stringify({ deviceId: getGuardDeviceId(), id: uuid("evt"), occurredAt: new Date().toISOString(), type: event.type, category: event.category, severity: event.severity, message: event.message, metadata: event.metadata || {}, snapshotBase64 }) });
  } catch (error) { console.warn("event upload", error); }
}

function showGuardWarning(text) {
  const banner = $("#guardWarningBanner");
  banner.textContent = text;
  banner.classList.add("show");
  clearTimeout(guard.warningTimer);
  guard.warningTimer = setTimeout(() => banner.classList.remove("show"), 6000);
}

function captureGuardSnapshot(quality = 0.68, maxWidth = 960) {
  const video = $("#guardVideo");
  if (!video.videoWidth) return null;
  const scale = Math.min(1, maxWidth / video.videoWidth);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  ctx.drawImage($("#guardOverlay"), 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

async function uploadGuardPreview() {
  if (!guard.active) return;
  const dataUrl = captureGuardSnapshot(0.48, 640);
  if (!dataUrl) return;
  const blob = await (await fetch(dataUrl)).blob();
  try { await api(`/api/agents/preview/${encodeURIComponent(getGuardDeviceId())}`, { method: "POST", headers: { "content-type": "image/jpeg" }, body: blob }); } catch { /* fallback only */ }
}

function speak(text) {
  if (!("speechSynthesis" in window) || !text || !$("#guardVoiceEnabled").checked || guard.config.voice?.enabled === false) return;
  const normalized = String(text).trim();
  if (!normalized || guard.voiceQueue.includes(normalized) || guard.currentVoiceText === normalized) return;
  guard.voiceQueue.push(normalized);
  pumpVoiceQueue();
}

function pumpVoiceQueue() {
  if (guard.voiceSpeaking || !guard.voiceQueue.length || !$("#guardVoiceEnabled").checked) return;
  const text = guard.voiceQueue.shift();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "ko-KR";
  utterance.rate = 0.93;
  utterance.pitch = 1;
  utterance.volume = guard.config.voice?.volume || 0.95;
  const voices = speechSynthesis.getVoices();
  utterance.voice = voices.find((voice) => voice.lang?.toLowerCase().startsWith("ko")) || null;
  guard.voiceSpeaking = true;
  guard.currentVoiceText = text;
  const finish = () => {
    guard.voiceSpeaking = false;
    guard.currentVoiceText = null;
    setTimeout(pumpVoiceQueue, 180);
  };
  utterance.onend = finish;
  utterance.onerror = finish;
  speechSynthesis.speak(utterance);
}

async function runGuardTest(kind) {
  const map = {
    helmet: { type: "HELMET_NOT_DETECTED", category: "보호구", severity: "high", message: "안전모 미착용 의심 상황이 감지되었습니다.", voice: "안전모를 착용해주세요." },
    goggles: { type: "SAFETY_GLASSES_NOT_DETECTED", category: "보호구", severity: "medium", message: "보안경 미착용 의심 상황이 감지되었습니다.", voice: "보안경을 착용해주세요." },
    mask: { type: "MASK_NOT_DETECTED", category: "보호구", severity: "medium", message: "마스크 미착용 의심 상황이 감지되었습니다.", voice: "마스크를 착용해주세요." },
    forklift: { type: "FORKLIFT_APPROACH", category: "중장비", severity: "high", message: "지게차 접근 경고를 시연했습니다.", voice: "지게차가 지나갑니다. 주의하세요." },
    zone: { type: "DANGER_ZONE_ENTRY", category: "위험구역", severity: "high", message: "위험구역 진입 경고를 시연했습니다.", voice: "위험구역입니다. 즉시 이동해주세요." },
    fall: { type: "FALL_CANDIDATE", category: "불안전 행동", severity: "critical", message: "넘어짐 의심 경고를 시연했습니다.", voice: "넘어짐 위험이 감지되었습니다. 확인해주세요." },
  };
  if (!guard.active) return toast("먼저 지킴이를 시작해주세요.");
  await triggerGuardEvent(map[kind]);
}

/* ---------- Zone and rules ---------- */

async function prepareZoneEditor() {
  if (!state.devices.length) return drawZoneCanvas();
  const select = $("#zoneDeviceSelect");
  if (!select.value) select.value = state.devices[0].id;
  await loadSelectedZone();
}

async function loadSelectedZone() {
  const deviceId = $("#zoneDeviceSelect").value;
  if (!deviceId) return;
  try {
    const config = await api(`/api/devices/${encodeURIComponent(deviceId)}/config`);
    state.zoneConfig = config;
    const zone = config.zones?.[0] || { name: "출입 제한 구역", severity: "high", enabled: false, points: [] };
    const enabled = config.rules?.dangerZone === true && zone.enabled !== false && Array.isArray(zone.points) && zone.points.length >= 3;
    $("#zoneUseEnabled").checked = enabled;
    state.zonePoints = Array.isArray(zone.points) ? zone.points.map(([x, y]) => [x, y]) : [];
    $("#zoneName").value = zone.name || "출입 제한 구역";
    $("#zoneSeverity").value = zone.severity || "high";
    const device = state.devices.find((item) => item.id === deviceId);
    state.zoneBackground = device?.previewUrl || null;
    updateZoneEditorEnabledState();
    drawZoneCanvas();
  } catch (error) { toast(error.message); }
}

function getLiveVideoForDevice(deviceId) {
  return $$(`.device-card[data-device-id="${CSS.escape(deviceId)}"] .device-video`).find((video) => !video.hidden && video.readyState >= 2) || null;
}

function updateZoneEditorEnabledState() {
  const enabled = $("#zoneUseEnabled").checked;
  $("#zoneName").disabled = !enabled;
  $("#zoneSeverity").disabled = !enabled;
  $("#zoneCanvas").classList.toggle("zone-disabled", !enabled);
  $("#zoneDisabledCover").hidden = enabled;
  drawZoneCanvas();
}

function drawZoneCanvas() {
  const canvas = $("#zoneCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#06131c";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const deviceId = $("#zoneDeviceSelect")?.value;
  const liveVideo = deviceId ? getLiveVideoForDevice(deviceId) : null;
  if (liveVideo) {
    ctx.drawImage(liveVideo, 0, 0, canvas.width, canvas.height);
  } else if (state.zoneBackground) {
    const image = new Image();
    image.onload = () => { ctx.drawImage(image, 0, 0, canvas.width, canvas.height); drawZonePolygon(ctx, canvas); };
    image.src = state.zoneBackground;
  }
  drawZonePolygon(ctx, canvas);
}

function drawZonePolygon(ctx, canvas) {
  if (!$("#zoneUseEnabled").checked || !state.zonePoints.length) return;
  ctx.beginPath();
  state.zonePoints.forEach(([x, y], index) => index ? ctx.lineTo(x * canvas.width, y * canvas.height) : ctx.moveTo(x * canvas.width, y * canvas.height));
  if (state.zonePoints.length >= 3) ctx.closePath();
  ctx.fillStyle = "rgba(255,55,82,.14)";
  if (state.zonePoints.length >= 3) ctx.fill();
  ctx.strokeStyle = "#ff3c58";
  ctx.lineWidth = 4;
  ctx.stroke();
  for (const [x, y] of state.zonePoints) {
    ctx.beginPath();
    ctx.arc(x * canvas.width, y * canvas.height, 8, 0, Math.PI * 2);
    ctx.fillStyle = "#ff3c58";
    ctx.fill();
  }
}

async function saveZone() {
  const deviceId = $("#zoneDeviceSelect").value;
  if (!deviceId) return toast("대상 장치를 선택해주세요.");
  const config = state.zoneConfig || await api(`/api/devices/${encodeURIComponent(deviceId)}/config`);
  config.rules ||= {};
  const enabled = $("#zoneUseEnabled").checked;
  if (!enabled) {
    config.rules.dangerZone = false;
    config.zones = [];
    state.zonePoints = [];
  } else {
    if (state.zonePoints.length < 3) return toast("위험구역 꼭짓점을 3개 이상 지정해주세요.");
    config.rules.dangerZone = true;
    config.zones = [{ id: "zone-main", name: $("#zoneName").value.trim() || "출입 제한 구역", severity: $("#zoneSeverity").value, enabled: true, points: state.zonePoints }];
  }
  await api(`/api/devices/${encodeURIComponent(deviceId)}/config`, { method: "PUT", body: JSON.stringify({ config }) });
  state.zoneConfig = config;
  toast(enabled ? "위험구역을 저장했습니다. 현장 지킴이에 자동 반영됩니다." : "이 장치의 위험구역 감지를 사용하지 않도록 설정했습니다.");
  updateZoneEditorEnabledState();
}

function clearZone() {
  state.zonePoints = [];
  drawZoneCanvas();
}

async function disableZone() {
  $("#zoneUseEnabled").checked = false;
  updateZoneEditorEnabledState();
  await saveZone();
}

function renderRuleGroups() {
  for (const [group, definitions] of Object.entries(ruleGroups)) {
    const container = $(`[data-rule-group="${group}"]`);
    if (!container) continue;
    container.innerHTML = definitions.map(([key, title, description, enabled]) => `<article class="feature-card"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p><label class="switch-row"><span><b>${enabled ? "활성 권장" : "선택 기능"}</b><small>장치별로 적용 여부를 설정합니다.</small></span><input type="checkbox" data-rule="${escapeHtml(key)}" ${enabled ? "checked" : ""} /></label></article>`).join("");
  }
}

async function loadRuleEditor(group) {
  const select = $(`#page-${group} .rule-device-select`);
  if (!select?.value && state.devices[0]) select.value = state.devices[0].id;
  const deviceId = select?.value;
  if (!deviceId) return;
  try {
    const config = await api(`/api/devices/${encodeURIComponent(deviceId)}/config`);
    $$(`#page-${group} [data-rule]`).forEach((input) => { input.checked = config.rules?.[input.dataset.rule] ?? defaultConfig().rules[input.dataset.rule]; });
  } catch { /* noop */ }
}

async function saveCurrentRuleGroup(button) {
  const page = button.closest(".page");
  const group = page.id.replace("page-", "");
  const deviceId = $(".rule-device-select", page).value;
  if (!deviceId) return toast("대상 장치를 선택해주세요.");
  try {
    const config = await api(`/api/devices/${encodeURIComponent(deviceId)}/config`);
    config.rules ||= {};
    $$('[data-rule]', page).forEach((input) => { config.rules[input.dataset.rule] = input.checked; });
    await api(`/api/devices/${encodeURIComponent(deviceId)}/config`, { method: "PUT", body: JSON.stringify({ config }) });
    toast("감지 규칙을 저장했습니다.");
  } catch (error) { toast(error.message); }
}

function renderReports() {
  const chart = $("#trendChart");
  if (!chart) return;
  const days = [...Array(7)].map((_, index) => {
    const date = new Date(Date.now() - (6 - index) * 86400000);
    const key = date.toISOString().slice(0, 10);
    const count = state.events.filter((event) => event.occurredAt?.startsWith(key)).length;
    return { label: `${date.getMonth() + 1}/${date.getDate()}`, count };
  });
  const max = Math.max(1, ...days.map((day) => day.count));
  chart.innerHTML = days.map((day) => `<div class="trend-column"><i style="height:${Math.max(4, day.count / max * 190)}px"></i><span>${day.label}<br />${day.count}건</span></div>`).join("");
  const top = Object.entries(state.summary?.categoryCounts || {}).sort((a, b) => b[1] - a[1])[0];
  $("#recommendations").innerHTML = [top ? `가장 빈번한 ‘${top[0]}’ 이벤트를 중심으로 현장 점검과 TBM 교육을 강화하세요.` : "현재 누적 이벤트가 적어 안정적으로 운영되고 있습니다.", "보호구 AI 결과는 현장 관리자 확인 후 조치 자료로 활용하세요.", "무전 호출 이력과 고위험 이벤트를 함께 검토하면 대응 시간을 줄일 수 있습니다."].map((text) => `<div class="recommendation">${escapeHtml(text)}</div>`).join("");
}

/* ---------- QR, export and UI ---------- */

function guardLink() {
  return `${location.origin}/?mode=user`;
}

function showQrModal() {
  $("#qrModal").hidden = false;
  $("#guardLinkInput").value = guardLink();
  const container = $("#qrCode");
  container.innerHTML = "";
  if (window.QRCode) {
    new window.QRCode(container, { text: guardLink(), width: 200, height: 200, colorDark: "#07131d", colorLight: "#ffffff", correctLevel: window.QRCode.CorrectLevel.H });
  } else {
    container.textContent = "QR 라이브러리 로딩 중";
    setTimeout(showQrModal, 500);
  }
}

async function copyGuardLink() {
  try { await navigator.clipboard.writeText(guardLink()); toast("현장 지킴이 링크를 복사했습니다."); } catch { $("#guardLinkInput").select(); document.execCommand("copy"); toast("링크를 복사했습니다."); }
}

function exportEvents() {
  const headers = ["발생시간", "장치", "유형", "등급", "내용", "상태"];
  const rows = state.events.map((event) => [event.occurredAt, event.deviceName, event.category, severityLabel(event.severity), event.message, event.status]);
  const csv = [headers, ...rows].map((row) => row.map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(",")).join("\n");
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `스마트안전지킴이_이벤트_${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}


/* ---------- V4 Work Stop Authority ---------- */

function activeWorkStops() {
  return (state.workStops || []).filter((item) => !["해제", "종료"].includes(item.status));
}

function updateWorkStopOverviewAlert() {
  const active = activeWorkStops();
  const banner = $("#workStopOverviewAlert");
  if (!banner) return;
  banner.hidden = active.length === 0;
  if (active.length) {
    const latest = active[0];
    $("#workStopOverviewText").textContent = `${latest.deviceName || latest.deviceId} · ${latest.reason}`;
  }
}

function renderWorkStops() {
  const list = $("#workStopList");
  const kpi = $("#workStopKpi");
  if (!list || !kpi) return;
  const items = state.workStops || [];
  const active = items.filter((item) => !["해제", "종료"].includes(item.status));
  const requested = items.filter((item) => item.status === "요청").length;
  const working = items.filter((item) => ["접수", "작업중지 확인", "조치 중"].includes(item.status)).length;
  const closed = items.filter((item) => ["해제", "종료"].includes(item.status)).length;
  kpi.innerHTML = [[active.length, "활성 요청"], [requested, "미접수"], [working, "조치 중"], [closed, "해제·종료"]]
    .map(([value, label]) => `<article><b>${value}</b><span>${label}</span></article>`).join("");
  list.innerHTML = items.map((item) => {
    const isActive = !["해제", "종료"].includes(item.status);
    return `<article class="stop-request-card ${isActive ? "active" : ""}" data-stop-id="${escapeHtml(item.id)}">
      <div><div class="stop-request-meta"><span class="stop-status-badge">${escapeHtml(item.status)}</span><span>${escapeHtml(item.deviceName || item.deviceId)}</span><span>${escapeHtml(item.site)} ${escapeHtml(item.area)}</span><span>${formatDate(item.requestedAt)}</span><span>요청자 ${escapeHtml(item.requesterName || "현장 작업자")}</span></div><h3>작업중지권 행사</h3><p class="stop-request-reason">${escapeHtml(item.reason)}</p></div>
      <div class="stop-request-actions"><button class="primary-button" data-stop-call="${escapeHtml(item.deviceId)}">무전 연결</button><button class="secondary-button" data-stop-status="접수">접수</button><button class="danger-button" data-stop-status="작업중지 확인">중지 확인</button><button class="secondary-button" data-stop-status="조치 중">조치 중</button><button class="secondary-button" data-stop-status="해제">해제</button></div>
    </article>`;
  }).join("") || `<div class="panel" style="padding:24px;color:var(--muted)">접수된 작업중지권 요청이 없습니다.</div>`;
  $$('[data-stop-call]', list).forEach((button) => button.addEventListener("click", () => initiateAdminCall(button.dataset.stopCall)));
  $$('[data-stop-status]', list).forEach((button) => button.addEventListener("click", async () => {
    const card = button.closest("[data-stop-id]");
    await updateWorkStopStatus(card.dataset.stopId, button.dataset.stopStatus);
  }));
}

function openWorkStopModal() {
  if (!guard.active) return toast("먼저 지킴이를 시작해주세요.");
  $("#workStopRequester").value ||= $("#guardWorkerName").value || "";
  $("#workStopReason").value = "";
  $("#workStopModal").hidden = false;
  setTimeout(() => $("#workStopReason").focus(), 50);
}

async function submitWorkStop() {
  const reason = $("#workStopReason").value.trim();
  if (reason.length < 5) return toast("작업중지 사유를 5자 이상 입력해주세요.");
  const button = $("#workStopSubmit");
  button.disabled = true;
  button.textContent = "긴급 전송 중...";
  try {
    const snapshotBase64 = captureGuardSnapshot(.78, 1120);
    const result = await api("/api/work-stop", {
      method: "POST",
      body: JSON.stringify({
        deviceId: getGuardDeviceId(),
        requesterName: $("#workStopRequester").value.trim() || "현장 작업자",
        requesterContact: $("#workStopContact").value.trim(),
        reason,
        snapshotBase64,
        autoCall: $("#workStopAutoCall").checked,
      }),
    });
    $("#workStopModal").hidden = true;
    showGuardWarning("작업중지권 요청이 관리자에게 긴급 전송되었습니다.");
    speak("작업중지권 요청이 접수되었습니다. 안전한 위치에서 대기해주세요.");
    toast(`작업중지권 요청 전송 완료${String(result.emailStatus || "").startsWith("sent") ? " · 이메일 발송" : ""}`, 5200);
    if ($("#workStopAutoCall").checked) setTimeout(() => initiateGuardCall(), 500);
  } catch (error) {
    toast(error.message, 6000);
  } finally {
    button.disabled = false;
    button.textContent = "작업중지 요청 전송";
  }
}

function startCriticalAlarm() {
  stopCriticalAlarm();
  beep(740, .18, .16);
  setTimeout(() => beep(980, .18, .14), 210);
  stopWorkState.alarmTimer = setInterval(() => {
    beep(740, .18, .14);
    setTimeout(() => beep(980, .18, .12), 210);
  }, 1100);
}

function stopCriticalAlarm() {
  clearInterval(stopWorkState.alarmTimer);
  stopWorkState.alarmTimer = null;
}

function handleIncomingWorkStop(message) {
  stopWorkState.selected = message;
  state.selectedWorkStopId = message.id;
  $("#adminWorkStopDetails").innerHTML = `<p><b>장치:</b> ${escapeHtml(message.device?.name || message.deviceId)}</p><p><b>위치:</b> ${escapeHtml(`${message.device?.site || ""} ${message.device?.area || ""}`)}</p><p><b>요청자:</b> ${escapeHtml(message.requesterName || "현장 작업자")}</p><p><b>사유:</b> ${escapeHtml(message.reason)}</p><p><b>시간:</b> ${formatDate(message.requestedAt)}</p>`;
  $("#adminWorkStopModal").hidden = false;
  startCriticalAlarm();
  if (document.hidden && "Notification" in window && Notification.permission === "granted") {
    new Notification("스마트 안전지킴이 · 작업중지권", { body: `${message.device?.name || message.deviceId}: ${message.reason}` });
  }
  loadDashboard(true);
}

function handleWorkStopStatus(message) {
  stopCriticalAlarm();
  if (state.session?.role === "user") {
    showGuardWarning(`작업중지권 상태: ${message.status}${message.note ? ` · ${message.note}` : ""}`);
    speak(`작업중지권 상태가 ${message.status}로 변경되었습니다.`);
  } else {
    toast(`작업중지권 상태가 ${message.status}(으)로 변경되었습니다.`);
    loadDashboard(true);
  }
}

async function updateWorkStopStatus(id, status) {
  try {
    await api(`/api/work-stop/${encodeURIComponent(id)}/status`, { method: "POST", body: JSON.stringify({ status }) });
    stopCriticalAlarm();
    $("#adminWorkStopModal").hidden = true;
    toast(`작업중지권 상태: ${status}`);
    await loadDashboard(true);
  } catch (error) { toast(error.message); }
}

/* ---------- V4 AI photo analysis ---------- */

function captureVideoFrame(video, quality = .78, maxWidth = 1280) {
  if (!video?.videoWidth || !video?.videoHeight) return null;
  const width = Math.min(maxWidth, video.videoWidth);
  const height = Math.round(video.videoHeight * (width / video.videoWidth));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.drawImage(video, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", quality);
}

function showPhotoAnalysisModal(imageDataUrl, status = "AI 분석 중") {
  $("#photoAnalysisModal").hidden = false;
  $("#photoAnalysisImage").src = imageDataUrl || "";
  $("#photoAnalysisStatus").textContent = status;
  $("#photoAnalysisText").textContent = "사진을 분석하고 있습니다. 잠시 기다려주세요.";
}

async function requestPhotoAnalysis(deviceId, imageDataUrl, sendEmail = true, speakResult = false) {
  if (!imageDataUrl) return toast("분석할 카메라 화면을 가져오지 못했습니다.");
  showPhotoAnalysisModal(imageDataUrl);
  try {
    const result = await api("/api/ai/photo-analysis", {
      method: "POST",
      body: JSON.stringify({ deviceId, imageBase64: imageDataUrl, sendEmail }),
    });
    state.photoAnalysisText = result.analysisText;
    $("#photoAnalysisStatus").textContent = `${result.provider} 분석 완료 · ${severityLabel(result.severity)} · 메일 ${result.emailStatus}`;
    $("#photoAnalysisText").textContent = result.analysisText;
    if (result.imageUrl) $("#photoAnalysisImage").src = result.imageUrl;
    if (speakResult) speak(result.analysisText.slice(0, 1200));
    toast("현장 사진 AI 분석이 완료되었습니다.");
    if (state.session?.role === "admin") loadDashboard(true);
  } catch (error) {
    $("#photoAnalysisStatus").textContent = "분석 실패";
    $("#photoAnalysisText").textContent = error.message;
    toast(error.message, 6000);
  }
}

async function analyzeGuardPhoto() {
  if (!guard.active) return toast("먼저 지킴이를 시작해주세요.");
  const image = captureVideoFrame($("#guardVideo"), .78, 1280);
  await requestPhotoAnalysis(getGuardDeviceId(), image, $("#guardAnalysisEmail").checked, guard.config.voice?.enabled !== false && $("#guardVoiceEnabled").checked);
}

async function analyzeDevicePhoto(deviceId) {
  const video = getLiveVideoForDevice(deviceId);
  if (!video?.srcObject) {
    requestWatch(deviceId, true, "high");
    return toast("실시간 영상 연결 후 다시 사진 분석을 눌러주세요.");
  }
  const image = captureVideoFrame(video, .80, 1280);
  await requestPhotoAnalysis(deviceId, image, true, false);
}

function handlePhotoAnalysisSignal(message) {
  if (state.session?.role === "admin") {
    state.photoAnalysisText = message.analysisText || "";
    showPhotoAnalysisModal(message.imageUrl || "", `현장 요청 분석 완료 · ${severityLabel(message.severity)}`);
    $("#photoAnalysisText").textContent = message.analysisText || "분석 결과가 없습니다.";
    toast(`현장 사진 AI 분석 완료 · ${severityLabel(message.severity)}`, 5000);
    loadDashboard(true);
  }
}

/* ---------- V4 TBM safety communication ---------- */

async function loadActiveTbm() {
  try {
    const active = await api("/api/tbm/active");
    if (state.session?.role === "admin") state.tbmActive = active?.id ? active : null;
    else guard.activeTbm = active?.id ? active : null;
    renderTbmDashboard();
    renderGuardTbm();
  } catch (error) { console.warn("TBM load", error); }
}

function renderGuardTbm() {
  const target = $("#guardTbmSummary");
  if (!target) return;
  const session = guard.activeTbm;
  if (!session) {
    target.textContent = "관리자가 TBM 내용을 등록하면 요약이 표시됩니다.";
    $("#guardTbmStatus").textContent = "대기";
    return;
  }
  target.textContent = session.summaryText;
  $("#guardTbmStatus").textContent = session.workDate || "활성";
}

function renderTbmDashboard() {
  const session = state.tbmActive;
  const meta = $("#tbmResultMeta");
  const text = $("#tbmResultText");
  const feedbackList = $("#tbmFeedbackList");
  if (!meta || !text || !feedbackList) return;
  if (!session) {
    meta.textContent = "활성화된 TBM이 없습니다.";
    text.textContent = "메일 내용을 입력하고 AI 요약을 생성해주세요.";
    feedbackList.innerHTML = `<div style="color:var(--muted)">제출된 작업자 의견이 없습니다.</div>`;
    return;
  }
  meta.textContent = `${session.subject} · 작업일 ${session.workDate || "미지정"} · ${formatDate(session.createdAt)}`;
  text.textContent = session.summaryText;
  feedbackList.innerHTML = (session.feedback || []).map((item) => `<article class="tbm-feedback-item"><header><b>${escapeHtml(item.worker_name || "익명")}</b><span>${formatDate(item.created_at)}</span></header><p>${escapeHtml(item.opinion)}</p><p class="ai-note"><b>AI 보완:</b><br>${escapeHtml(item.ai_recommendation || "검토 대기")}</p></article>`).join("") || `<div style="color:var(--muted)">제출된 작업자 의견이 없습니다.</div>`;
}

async function createTbmSessionFromMail() {
  const emailBody = $("#tbmEmailBody").value.trim();
  if (emailBody.length < 10) return toast("D-안전회의 메일 본문을 입력해주세요.");
  const button = $("#tbmCreateSession");
  button.disabled = true;
  button.textContent = "AI 요약 생성 중...";
  try {
    const result = await api("/api/tbm/sessions", {
      method: "POST",
      body: JSON.stringify({
        subject: $("#tbmSubject").value.trim() || "D-안전회의",
        workDate: $("#tbmWorkDate").value,
        sourceEmail: $("#tbmSourceEmail").value.trim(),
        managerEmail: $("#tbmManagerEmail").value.trim(),
        emailBody,
        sendEmail: $("#tbmSendEmail").checked,
      }),
    });
    toast(`TBM 요약이 생성되었습니다. 메일 ${result.emailStatus}`);
    await loadDashboard(true);
    goToPage("tbm");
  } catch (error) { toast(error.message, 6500); }
  finally { button.disabled = false; button.textContent = "AI 요약 생성·TBM 활성화"; }
}

async function submitTbmFeedback() {
  const session = guard.activeTbm;
  const opinion = $("#guardTbmOpinion").value.trim();
  if (!session) return toast("활성화된 TBM이 없습니다.");
  if (opinion.length < 3) return toast("현장 의견을 3자 이상 입력해주세요.");
  const button = $("#guardTbmSubmit");
  button.disabled = true;
  button.textContent = "AI 검토·전송 중...";
  try {
    const result = await api("/api/tbm/feedback", {
      method: "POST",
      body: JSON.stringify({ sessionId: session.id, deviceId: getGuardDeviceId(), workerName: $("#guardWorkerName").value.trim() || "익명", opinion }),
    });
    $("#guardTbmOpinion").value = "";
    toast(`작업자 의견이 반영되었습니다. 메일 ${result.emailStatus}`, 5000);
    speak("작업자 의견이 담당자에게 전달되었습니다.");
    await loadActiveTbm();
  } catch (error) { toast(error.message, 6500); }
  finally { button.disabled = false; button.textContent = "의견 제출·담당자 전송"; }
}

function bindEvents() {
  $("#loginForm").addEventListener("submit", login);
  $$('[data-login-role]').forEach((button) => button.addEventListener("click", () => setLoginRole(button.dataset.loginRole)));
  $("#logoutButton").addEventListener("click", logout);
  $$(".nav-item").forEach((button) => button.addEventListener("click", () => goToPage(button.dataset.page)));
  $$('[data-goto]').forEach((button) => button.addEventListener("click", () => goToPage(button.dataset.goto)));
  $("#mobileMenu").addEventListener("click", () => document.body.classList.toggle("sidebar-open"));
  $("#sidebarScrim").addEventListener("click", () => document.body.classList.remove("sidebar-open"));

  [$("#guardStartButton"), $("#guardTopButton")].forEach((button) => button.addEventListener("click", toggleGuard));
  $("#guardAlarmButton").addEventListener("click", toggleGuardAlarm);
  $("#guardVoiceEnabled").addEventListener("change", () => {
    if (!$("#guardVoiceEnabled").checked) stopSafetyAlerts();
    updateGuardAlarmUi();
    saveGuardProfile(false);
  });
  $("#guardZoneEnabled").addEventListener("change", () => { saveGuardProfile(false); drawGuardOverlay(guard.detections, 0, 0); });
  $("#guardSaveProfile").addEventListener("click", () => saveGuardProfile(true));
  $("#guardCameraSelect").addEventListener("change", restartGuardCamera);
  $("#guardCallAdminButton").addEventListener("click", initiateGuardCall);
  $("#workStopButton").addEventListener("click", openWorkStopModal);
  $("#workStopSubmit").addEventListener("click", submitWorkStop);
  $("#guardPhotoAnalyzeButton").addEventListener("click", analyzeGuardPhoto);
  $("#guardTbmSpeak").addEventListener("click", () => guard.activeTbm && speak(guard.activeTbm.summaryText));
  $("#guardTbmSubmit").addEventListener("click", submitTbmFeedback);
  $$('[data-guard-test]').forEach((button) => button.addEventListener("click", () => runGuardTest(button.dataset.guardTest)));
  $("#guardVideo").addEventListener("loadedmetadata", resizeGuardOverlay);
  addEventListener("resize", () => { resizeGuardOverlay(); if (state.currentPage === "zones") drawZoneCanvas(); });

  [$("#qrOpenButton"), $("#heroQrButton"), $("#deviceQrButton"), $("#settingsQrButton")].forEach((button) => button?.addEventListener("click", showQrModal));
  $("#copyGuardLink").addEventListener("click", copyGuardLink);
  $$('[data-close-modal]').forEach((button) => button.addEventListener("click", () => { $("#" + button.dataset.closeModal).hidden = true; }));

  $("#acceptCallButton").addEventListener("click", acceptIncomingCall);
  $("#rejectCallButton").addEventListener("click", rejectIncomingCall);
  $("#endCallButton").addEventListener("click", () => endCall(true));
  $("#callCloseButton").addEventListener("click", () => callState.status === "incoming" ? rejectIncomingCall() : endCall(true));
  $("#floatingCallOpen").addEventListener("click", () => { $("#callModal").hidden = false; });
  $("#pttButton").addEventListener("click", toggleCallMic);
  $("#remoteAudioPlayButton").addEventListener("click", playRemoteCallAudio);

  $("#refreshLive").addEventListener("click", () => { for (const device of state.devices) requestWatch(device.id, true, state.liveViewDeviceId === device.id ? "high" : "low"); loadDashboard(true); });
  $("#liveViewClose").addEventListener("click", closeLiveView);
  $("#liveViewReconnect").addEventListener("click", () => state.liveViewDeviceId && requestWatch(state.liveViewDeviceId, true, "high"));
  $("#liveViewFullscreen").addEventListener("click", toggleLiveViewFullscreen);
  $("#liveViewCall").addEventListener("click", () => state.liveViewDeviceId && initiateAdminCall(state.liveViewDeviceId));
  $("#liveViewAnalyze").addEventListener("click", () => state.liveViewDeviceId && analyzeDevicePhoto(state.liveViewDeviceId));
  $("#photoAnalysisSpeak").addEventListener("click", () => state.photoAnalysisText && speak(state.photoAnalysisText.slice(0, 1600)));
  $("#adminStopCall").addEventListener("click", () => stopWorkState.selected?.deviceId && initiateAdminCall(stopWorkState.selected.deviceId));
  $("#adminStopAcknowledge").addEventListener("click", () => state.selectedWorkStopId && updateWorkStopStatus(state.selectedWorkStopId, "접수"));
  $("#adminStopConfirm").addEventListener("click", () => state.selectedWorkStopId && updateWorkStopStatus(state.selectedWorkStopId, "작업중지 확인"));
  $("#adminStopClose").addEventListener("click", () => { stopCriticalAlarm(); $("#adminWorkStopModal").hidden = true; });
  $("#workStopAlarmTest").addEventListener("click", () => { startCriticalAlarm(); toast("작업중지권 긴급 알람 시험 중"); setTimeout(stopCriticalAlarm, 5000); });
  $("#tbmCreateSession").addEventListener("click", createTbmSessionFromMail);
  $("#tbmSpeakSummary").addEventListener("click", () => state.tbmActive && speak(state.tbmActive.summaryText));
  $("#tbmRefresh").addEventListener("click", () => loadDashboard(true));
  $("#liveViewModal").addEventListener("click", (event) => { if (event.target === $("#liveViewModal")) closeLiveView(); });
  $("#simulateEvent").addEventListener("click", simulateEvent);
  $("#applyEventFilter").addEventListener("click", renderEventTable);
  $("#exportEvents").addEventListener("click", exportEvents);
  $("#printReport").addEventListener("click", () => print());

  $("#zoneDeviceSelect").addEventListener("change", loadSelectedZone);
  $("#zoneCanvas").addEventListener("click", (event) => {
    if (!$("#zoneUseEnabled").checked) return toast("먼저 위험구역 기능 사용을 켜주세요.");
    const rect = event.currentTarget.getBoundingClientRect();
    state.zonePoints.push([(event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height]);
    drawZoneCanvas();
  });
  $("#zoneUseEnabled").addEventListener("change", updateZoneEditorEnabledState);
  $("#clearZone").addEventListener("click", clearZone);
  $("#disableZone").addEventListener("click", disableZone);
  $("#saveZone").addEventListener("click", saveZone);

  $$(".rule-device-select").forEach((select) => select.addEventListener("change", () => loadRuleEditor(select.closest(".page").id.replace("page-", ""))));
  $$(".rule-save").forEach((button) => button.addEventListener("click", () => saveCurrentRuleGroup(button)));
  $$(".speak-sample").forEach((button) => button.addEventListener("click", () => { unlockAudio(); speak(button.dataset.text); }));

  addEventListener("beforeunload", () => {
    if (guard.active) navigator.sendBeacon?.("/api/agents/offline", new Blob([JSON.stringify({ deviceId: getGuardDeviceId() })], { type: "application/json" }));
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.session?.role === "admin") syncAdminWatchRequests();
  });
}

async function init() {
  bindEvents();
  renderRuleGroups();
  loadGuardProfile();
  $("#apiOrigin").textContent = location.origin;
  if ($("#tbmWorkDate")) $("#tbmWorkDate").value = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  updateClock();
  setInterval(updateClock, 1000);
  await loadIceServers();
  await restoreSession();
  try {
    const health = await api("/api/health");
    $("#cloudStatusText").textContent = health.ok ? "연결 상태 정상" : "연결 확인 필요";
  } catch { $("#cloudStatusText").textContent = "연결 확인 필요"; }
  if ("Notification" in window && Notification.permission === "default") {
    document.addEventListener("click", () => Notification.requestPermission().catch(() => {}), { once: true });
  }
}

init();
