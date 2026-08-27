const state = {
  page: "overview",
  summary: null,
  devices: [],
  events: [],
  reports: [],
  selectedRuleDeviceId: null,
  zonePoints: [],
  zoneImage: null,
};

const PAGE_TITLES = {
  overview: "통합 대시보드",
  guard: "현장 스마트 안전지킴이",
  live: "실시간 관제",
  devices: "장치 관리",
  zones: "위험구역 설정",
  ppe: "근로자 보호구",
  behavior: "불안전 행동",
  environment: "작업환경",
  equipment: "중장비 위험사항",
  events: "이벤트 센터",
  reports: "리포트",
  settings: "설정",
};

const FEATURES = {
  ppe: [
    ["helmet", "안전모", "안전모 착용 여부를 확인하고 반복 미검출 시 관리자 확인을 요청합니다.", "◉"],
    ["safetyGlasses", "보안경", "근거리 영상에서 보안경 착용 여부를 분석합니다.", "◌"],
    ["harness", "안전대", "고소작업자의 안전대 착용 여부를 확인합니다.", "⋈"],
    ["hookConnected", "안전대 후크 체결", "랜야드·후크와 앵커포인트의 연결 상태를 확인합니다.", "⌁"],
  ],
  behavior: [
    ["dangerZone", "위험구역 진입", "설정된 출입 제한 구역에 작업자가 진입하는지 감지합니다.", "⌖"],
    ["fall", "넘어짐 의심", "자세와 지속시간을 분석해 넘어짐 가능성을 알립니다.", "↘"],
    ["unsafePosture", "불안전 자세", "작업 특성에 맞지 않는 자세가 지속되는지 확인합니다.", "⚠"],
    ["running", "급격한 이동", "제조 현장 내 달리기나 급격한 이동 후보를 확인합니다.", "»"],
  ],
  environment: [
    ["obstacle", "통로 장애물", "통행 경로에 자재나 장애물이 놓여 있는지 확인합니다.", "◇"],
    ["blockedAisle", "안전통로 점유", "안전통로가 물건이나 장비로 점유되었는지 확인합니다.", "▥"],
    ["smoke", "연기 의심", "영상에서 연기 형태가 확인되면 관리자 확인을 요청합니다.", "≋"],
    ["fire", "화염 의심", "화염 형태가 감지되면 긴급 이벤트를 생성합니다.", "△"],
  ],
  equipment: [
    ["forklift", "지게차 감지", "지게차 진입과 작업자 접근을 감지하고 한국어 음성으로 알립니다.", "▰"],
    ["heavyEquipmentProximity", "중장비 근접", "작업자와 중장비의 위험거리 접근을 확인합니다.", "◎"],
    ["craneLoad", "인양물 하부 접근", "크레인 인양물 하부에 작업자가 접근하는지 확인합니다.", "⇅"],
    ["vehicleRoute", "차량 동선 침범", "작업자가 지정된 차량 동선에 진입하는지 확인합니다.", "↔"],
  ],
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
  return data.data ?? data;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function toast(message) {
  const container = $("#toastContainer");
  const item = document.createElement("div");
  item.className = "toast";
  item.textContent = message;
  container.appendChild(item);
  setTimeout(() => item.remove(), 3200);
}

function speak(text) {
  if (!("speechSynthesis" in window)) return toast("이 브라우저는 음성 합성을 지원하지 않습니다.");
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "ko-KR";
  utterance.rate = 0.94;
  utterance.pitch = 1;
  utterance.volume = 1;
  speechSynthesis.speak(utterance);
}

function relativeTime(iso) {
  if (!iso) return "기록 없음";
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}초 전`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}시간 전`;
  return new Date(iso).toLocaleDateString("ko-KR");
}

function formatDate(iso) {
  return new Date(iso).toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function severityLabel(value) {
  return value === "critical" ? "긴급" : value === "high" ? "위험" : value === "medium" ? "주의" : "정보";
}

function riskClass(value) {
  if (value === "정상") return "risk-normal";
  if (value === "주의") return "risk-warning";
  return "risk-danger";
}

function navigate(page) {
  state.page = page;
  $$(".page").forEach((el) => el.classList.toggle("active", el.id === `page-${page}`));
  $$(".nav-item").forEach((el) => el.classList.toggle("active", el.dataset.page === page));
  $("#pageTitle").textContent = PAGE_TITLES[page] || "스마트 안전지킴이";
  if (page === "zones") setupZoneEditor();
  if (["ppe", "behavior", "environment", "equipment"].includes(page)) renderRulePage(page);
  if (page === "reports") loadReports();
  if (page === "guard") history.replaceState(null, "", "/guard");
  else if (location.pathname === "/guard") history.replaceState(null, "", "/");
}

function deviceCard(device, live = false) {
  const statusClass = device.status === "online" ? "" : "offline";
  const risk = device.status === "offline" ? "연결 끊김" : device.currentRisk;
  return `
    <article class="device-card">
      <div class="camera-frame">
        ${device.previewUrl ? `<img src="${escapeHtml(device.previewUrl)}?t=${Date.now()}" alt="${escapeHtml(device.name)} 프리뷰" />` : `<div class="camera-placeholder"><div><b>◫</b>카메라 프리뷰 대기</div></div>`}
        <span class="live-badge ${statusClass}">${device.status === "online" ? "● LIVE" : "○ OFFLINE"}</span>
        <span class="people-badge">작업자 ${device.peopleCount}명</span>
      </div>
      <div class="device-meta">
        <div class="device-meta-head"><div><h4>${escapeHtml(device.name)}</h4><p>${escapeHtml(device.site)} · ${escapeHtml(device.area)}</p></div><span class="risk-chip ${riskClass(risk)}">${escapeHtml(risk)}</span></div>
        <div class="device-stats"><span>FPS<b>${device.fps.toFixed(1)}</b></span><span>CPU<b>${device.cpu.toFixed(0)}%</b></span><span>MEM<b>${device.memory.toFixed(0)}%</b></span></div>
      </div>
    </article>`;
}

function renderKpis() {
  const s = state.summary || {};
  const cards = [
    ["온라인 장치", `${s.online || 0}/${s.totalDevices || 0}`, "정상 연결", "#50e38f"],
    ["현재 작업자", s.people || 0, "AI 감지 인원", "#59e0dc"],
    ["오늘 이벤트", s.todayEvents || 0, "최근 24시간", "#3aa9ff"],
    ["고위험 경고", s.highRisk || 0, "즉시 확인 대상", "#ff5d70"],
    ["미확인 이벤트", s.unacknowledged || 0, "관리자 조치 필요", "#ffd166"],
  ];
  $("#kpiGrid").innerHTML = cards.map(([label, value, sub, color]) => `<div class="kpi-card" style="--accent:${color}"><span class="kpi-label">${label}</span><strong>${value}</strong><small>${sub}</small></div>`).join("");
}

function renderDevices() {
  const devices = state.devices;
  $("#overviewDevices").innerHTML = devices.slice(0, 3).map((d) => deviceCard(d)).join("") || `<div class="empty-state">등록된 장치가 없습니다.</div>`;
  $("#liveDevices").innerHTML = devices.map((d) => deviceCard(d, true)).join("") || `<div class="empty-state">등록된 장치가 없습니다.</div>`;
  $("#deviceTableBody").innerHTML = devices.map((d) => `
    <tr><td><b>${escapeHtml(d.name)}</b><small>${escapeHtml(d.id)} · ${escapeHtml(d.cameraLabel)}</small></td><td>${escapeHtml(d.site)}<small>${escapeHtml(d.area)}</small></td><td><span class="status-chip status-${d.status}">${d.status === "online" ? "온라인" : "오프라인"}</span></td><td>${d.peopleCount}명</td><td>${d.fps.toFixed(1)}</td><td>${d.cpu.toFixed(0)}%</td><td>${d.memory.toFixed(0)}%</td><td>${relativeTime(d.lastSeen)}</td></tr>`).join("");
  updateDeviceSelects();
}

function eventRow(event) {
  return `<div class="event-row"><span class="event-time">${formatDate(event.occurredAt)}</span><span class="event-device">${escapeHtml(event.deviceName)}</span><span class="event-message">${escapeHtml(event.message)}</span><span class="severity severity-${event.severity}">${severityLabel(event.severity)}</span></div>`;
}

function renderEvents() {
  $("#overviewEvents").innerHTML = state.events.slice(0, 6).map(eventRow).join("") || `<div class="empty-state">이벤트가 없습니다.</div>`;
  $("#eventTableBody").innerHTML = state.events.map((e) => `
    <tr><td>${formatDate(e.occurredAt)}</td><td><b>${escapeHtml(e.deviceName)}</b><small>${escapeHtml(e.site)}</small></td><td>${escapeHtml(e.category)}</td><td><span class="severity severity-${e.severity}">${severityLabel(e.severity)}</span></td><td>${escapeHtml(e.message)}</td><td>${e.acknowledged ? `<span class="status-chip status-online">${escapeHtml(e.status)}</span>` : `<span class="status-chip risk-warning">확인 필요</span>`}</td><td>${e.acknowledged ? "-" : `<button class="action-link ack-event" data-id="${escapeHtml(e.id)}">확인 완료</button>`}</td></tr>`).join("");
  $$(".ack-event").forEach((button) => button.addEventListener("click", () => acknowledgeEvent(button.dataset.id)));
}

function renderCategoryChart() {
  const counts = state.summary?.categoryCounts || {};
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, count]) => count));
  $("#categoryChart").innerHTML = (entries.length ? entries : [["위험구역",0],["보호구",0],["중장비",0],["작업환경",0]]).map(([name, count]) => `<div class="category-bar-row"><span>${escapeHtml(name)}</span><div class="bar-track"><div class="bar-fill" style="width:${(count/max)*100}%"></div></div><b>${count}</b></div>`).join("");
}

function renderBriefing() {
  const s = state.summary || {};
  const topCategory = Object.entries(s.categoryCounts || {}).sort((a,b) => b[1]-a[1])[0];
  const main = s.highRisk > 0
    ? `현재 <b>${s.highRisk}건의 고위험 이벤트</b>가 확인되었습니다. 미확인 이벤트를 우선 검토하고 현장 관리자에게 조치 여부를 확인하세요.`
    : `현재 연결된 현장은 <b>안정 상태</b>입니다. AI가 위험구역·작업자 행동·중장비 접근을 지속적으로 분석하고 있습니다.`;
  const points = [
    topCategory ? `오늘 가장 많이 발생한 유형은 ‘${topCategory[0]}’ ${topCategory[1]}건입니다.` : "오늘 누적 이벤트가 없습니다.",
    `${s.online || 0}대의 Edge 장치가 중앙 관제에 연결되어 있습니다.`,
    s.unacknowledged ? `관리자 확인이 필요한 이벤트가 ${s.unacknowledged}건 남아 있습니다.` : "모든 이벤트가 확인된 상태입니다.",
  ];
  $("#aiBriefing").innerHTML = `<div class="brief-main">${main}</div><div class="ai-points">${points.map((p) => `<div class="ai-point"><i></i><span>${escapeHtml(p)}</span></div>`).join("")}</div>`;
}

function updateDeviceSelects() {
  const options = state.devices.map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)} · ${escapeHtml(d.area)}</option>`).join("");
  [$("#zoneDeviceSelect"), ...$$(".rule-device-select")].filter(Boolean).forEach((select) => {
    const previous = select.value;
    select.innerHTML = options;
    if (state.devices.some((d) => d.id === previous)) select.value = previous;
  });
  const filter = $("#eventDeviceFilter");
  if (filter) filter.innerHTML = `<option value="">전체 장치</option>${options}`;
}

async function loadDashboard(silent = false) {
  if (!silent) document.body.classList.add("loading");
  try {
    const [summary, devices, events] = await Promise.all([
      api("/api/dashboard/summary"), api("/api/devices"), api("/api/events?limit=100"),
    ]);
    state.summary = summary;
    state.devices = devices;
    state.events = events;
    renderKpis(); renderDevices(); renderEvents(); renderCategoryChart(); renderBriefing();
  } catch (err) {
    toast(`데이터를 불러오지 못했습니다: ${err.message}`);
  } finally {
    document.body.classList.remove("loading");
  }
}

async function acknowledgeEvent(id) {
  try {
    await api(`/api/events/${encodeURIComponent(id)}/ack`, { method: "POST", body: JSON.stringify({ status: "확인 완료" }) });
    toast("이벤트를 확인 완료 처리했습니다.");
    await loadDashboard(true);
  } catch (err) { toast(err.message); }
}

async function simulateEvent() {
  try {
    await api("/api/demo/simulate", { method: "POST", body: JSON.stringify({}) });
    toast("시연용 위험 이벤트를 생성했습니다.");
    await loadDashboard(true);
  } catch (err) { toast(err.message); }
}

function ruleGroupFromPage(page) {
  return FEATURES[page] || [];
}

function renderRulePage(page) {
  const group = $(`[data-rule-group="${page}"]`);
  if (!group) return;
  const select = $(`#page-${page} .rule-device-select`);
  const device = state.devices.find((d) => d.id === select?.value) || state.devices[0];
  state.selectedRuleDeviceId = device?.id || null;
  const rules = device?.config?.rules || {};
  group.innerHTML = ruleGroupFromPage(page).map(([key, title, desc, icon]) => `
    <div class="feature-card"><div class="feature-icon">${icon}</div><div><h4>${title}</h4><p>${desc}</p></div><label class="toggle"><input type="checkbox" data-rule-key="${key}" ${rules[key] ? "checked" : ""}><span></span></label></div>`).join("");
}

async function saveRules(button) {
  const page = button.closest(".page").id.replace("page-", "");
  const select = $(`#page-${page} .rule-device-select`);
  const device = state.devices.find((d) => d.id === select.value);
  if (!device) return toast("대상 장치를 선택하세요.");
  const config = structuredClone(device.config || { rules: {} });
  config.rules ||= {};
  $$(`#page-${page} [data-rule-key]`).forEach((input) => { config.rules[input.dataset.ruleKey] = input.checked; });
  try {
    await api(`/api/devices/${encodeURIComponent(device.id)}/config`, { method: "PUT", body: JSON.stringify({ config }) });
    device.config = config;
    toast(`${device.name} 감지 규칙을 저장했습니다.`);
  } catch (err) { toast(err.message); }
}

function zoneDevice() {
  return state.devices.find((d) => d.id === $("#zoneDeviceSelect")?.value) || state.devices[0];
}

function setupZoneEditor() {
  const canvas = $("#zoneCanvas");
  if (!canvas || !state.devices.length) return;
  const device = zoneDevice();
  const zone = device?.config?.zones?.[0];
  state.zonePoints = (zone?.points || []).map(([x,y]) => [x,y]);
  $("#zoneName").value = zone?.name || "출입 제한 구역";
  $("#zoneSeverity").value = zone?.severity || "high";
  loadZoneImage(device);
  drawZoneCanvas();
}

function loadZoneImage(device) {
  state.zoneImage = null;
  if (!device?.previewUrl) return drawZoneCanvas();
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => { state.zoneImage = img; drawZoneCanvas(); };
  img.onerror = () => { state.zoneImage = null; drawZoneCanvas(); };
  img.src = `${device.previewUrl}?t=${Date.now()}`;
}

function drawZoneCanvas() {
  const canvas = $("#zoneCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0,0,canvas.width,canvas.height);
  const gradient = ctx.createLinearGradient(0,0,canvas.width,canvas.height);
  gradient.addColorStop(0,"#0b202b"); gradient.addColorStop(1,"#061119");
  ctx.fillStyle = gradient; ctx.fillRect(0,0,canvas.width,canvas.height);
  if (state.zoneImage) ctx.drawImage(state.zoneImage,0,0,canvas.width,canvas.height);
  else {
    ctx.strokeStyle = "rgba(89,224,220,.10)"; ctx.lineWidth = 1;
    for(let x=0;x<canvas.width;x+=50){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,canvas.height);ctx.stroke();}
    for(let y=0;y<canvas.height;y+=50){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(canvas.width,y);ctx.stroke();}
    ctx.fillStyle="#53727a";ctx.font="26px Segoe UI";ctx.textAlign="center";ctx.fillText("장치 프리뷰 대기 · 클릭하여 위험구역 설정",canvas.width/2,canvas.height/2);
  }
  if (state.zonePoints.length) {
    const pts = state.zonePoints.map(([x,y]) => [x*canvas.width,y*canvas.height]);
    ctx.beginPath();ctx.moveTo(...pts[0]);pts.slice(1).forEach((p)=>ctx.lineTo(...p));
    if(pts.length>=3)ctx.closePath();
    ctx.fillStyle="rgba(255,55,82,.20)";ctx.fill();ctx.strokeStyle="#ff5268";ctx.lineWidth=4;ctx.stroke();
    pts.forEach(([x,y],i)=>{ctx.beginPath();ctx.arc(x,y,8,0,Math.PI*2);ctx.fillStyle="#ff5268";ctx.fill();ctx.fillStyle="#fff";ctx.font="14px Segoe UI";ctx.textAlign="center";ctx.fillText(String(i+1),x,y-14);});
  }
}

async function saveZone() {
  const device = zoneDevice();
  if (!device) return toast("대상 장치를 선택하세요.");
  if (state.zonePoints.length < 3) return toast("위험구역 꼭짓점을 3개 이상 지정하세요.");
  const config = structuredClone(device.config || {});
  config.zones = [{ id: "zone-main", name: $("#zoneName").value || "출입 제한 구역", severity: $("#zoneSeverity").value, enabled: true, points: state.zonePoints }];
  config.rules ||= {}; config.rules.dangerZone = true;
  try {
    await api(`/api/devices/${encodeURIComponent(device.id)}/config`, { method: "PUT", body: JSON.stringify({ config }) });
    device.config = config;
    toast(`${device.name} 위험구역 설정을 저장했습니다.`);
  } catch (err) { toast(err.message); }
}

async function loadEventsWithFilter() {
  const params = new URLSearchParams({ limit: "300" });
  const device = $("#eventDeviceFilter").value; const category = $("#eventCategoryFilter").value; const severity = $("#eventSeverityFilter").value;
  if (device) params.set("deviceId", device); if (category) params.set("category", category); if (severity) params.set("severity", severity);
  try { state.events = await api(`/api/events?${params}`); renderEvents(); } catch (err) { toast(err.message); }
}

function exportEvents() {
  const rows = [["발생시간","장치","사업장","유형","등급","내용","상태"], ...state.events.map((e)=>[e.occurredAt,e.deviceName,e.site,e.category,severityLabel(e.severity),e.message,e.status])];
  const csv = rows.map((r)=>r.map((v)=>`"${String(v??"").replaceAll('"','""')}"`).join(",")).join("\n");
  const blob = new Blob(["\ufeff"+csv],{type:"text/csv;charset=utf-8"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=`safety-events-${new Date().toISOString().slice(0,10)}.csv`;a.click();URL.revokeObjectURL(a.href);
}

async function loadReports() {
  try {
    state.reports = await api("/api/reports/daily?days=7");
    const map = new Map();
    state.reports.forEach((r)=>map.set(r.day,(map.get(r.day)||0)+Number(r.count)));
    const days=[];for(let i=6;i>=0;i--){const d=new Date(Date.now()-i*86400000).toISOString().slice(0,10);days.push([d,map.get(d)||0]);}
    const max=Math.max(1,...days.map(([,v])=>v));
    $("#trendChart").innerHTML=days.map(([day,value])=>`<div class="trend-column"><b>${value}</b><div class="trend-bar" style="height:${Math.max(4,(value/max)*88)}%"></div><small>${day.slice(5)}</small></div>`).join("");
    const top=Object.entries(state.summary?.categoryCounts||{}).sort((a,b)=>b[1]-a[1]);
    $("#recommendations").innerHTML=[
      ["반복 위험 집중관리", top[0] ? `‘${top[0][0]}’ 유형이 오늘 ${top[0][1]}건으로 가장 많이 발생했습니다. 해당 구역의 통제선과 작업 전 안내를 재확인하세요.` : "최근 반복되는 위험 유형이 없습니다."],
      ["미확인 이벤트 조치", `현재 미확인 이벤트 ${state.summary?.unacknowledged||0}건입니다. 고위험 순서로 현장 조치 여부를 확인하세요.`],
      ["Edge 장치 운영", `${state.summary?.online||0}/${state.summary?.totalDevices||0}대가 온라인입니다. 오프라인 장치의 전원과 네트워크를 확인하세요.`],
    ].map(([title,text])=>`<div class="recommendation"><b>${title}</b><p>${text}</p></div>`).join("");
  } catch (err) { toast(err.message); }
}

const GUARD_PROFILE_KEY = "pfm-smart-safety-guard-profile-v2";
const GUARD_DEVICE_ID_KEY = "pfm-smart-safety-device-id-v2";

const guardState = {
  active: false,
  starting: false,
  stream: null,
  model: null,
  modelLoading: null,
  modelStatus: "대기",
  config: null,
  peopleCount: 0,
  analysisFps: 0,
  currentRisk: "정상",
  previewTimer: null,
  heartbeatTimer: null,
  configTimer: null,
  inferenceTimer: null,
  inferenceBusy: false,
  lastInferenceAt: 0,
  lastZoneEventAt: 0,
  lastVehicleEventAt: 0,
  zoneEnteredAt: 0,
  warningTimer: null,
};

function localStorageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function localStorageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

function getGuardDeviceId() {
  let value = localStorageGet(GUARD_DEVICE_ID_KEY);
  if (!value) {
    const unique = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    value = `browser-${unique}`;
    localStorageSet(GUARD_DEVICE_ID_KEY, value);
  }
  return value;
}

function defaultGuardProfile() {
  const suffix = getGuardDeviceId().replaceAll("-", "").slice(-4).toUpperCase();
  return {
    name: `웹 지킴이 ${suffix}`,
    site: "POSCO Future M 시연 현장",
    area: "노트북 웹캠 구역",
    cameraId: "",
    voiceEnabled: true,
    zoneEnabled: true,
  };
}

function readStoredGuardProfile() {
  const fallback = defaultGuardProfile();
  try {
    return { ...fallback, ...(JSON.parse(localStorageGet(GUARD_PROFILE_KEY) || "{}")) };
  } catch {
    return fallback;
  }
}

function guardProfileFromInputs() {
  return {
    name: $("#guardDeviceName")?.value.trim() || defaultGuardProfile().name,
    site: $("#guardSite")?.value.trim() || "미지정 사업장",
    area: $("#guardArea")?.value.trim() || "미지정 구역",
    cameraId: $("#guardCameraSelect")?.value || "",
    voiceEnabled: Boolean($("#guardVoiceEnabled")?.checked),
    zoneEnabled: Boolean($("#guardZoneEnabled")?.checked),
  };
}

function loadGuardProfileUi() {
  const profile = readStoredGuardProfile();
  $("#guardDeviceName").value = profile.name;
  $("#guardSite").value = profile.site;
  $("#guardArea").value = profile.area;
  $("#guardVoiceEnabled").checked = profile.voiceEnabled;
  $("#guardZoneEnabled").checked = profile.zoneEnabled;
  $("#guardDeviceId").textContent = getGuardDeviceId();
  $("#guardCameraSelect").dataset.preferred = profile.cameraId || "";
}

function saveGuardProfile() {
  const profile = guardProfileFromInputs();
  localStorageSet(GUARD_PROFILE_KEY, JSON.stringify(profile));
  $("#guardCameraSelect").dataset.preferred = profile.cameraId || "";
  return profile;
}

function setGuardStatus(text, mode = "idle") {
  const pill = $("#guardStatusPill");
  if (!pill) return;
  pill.className = `guard-status-pill ${mode}`;
  $("b", pill).textContent = text;
}

function updateGuardUi() {
  const active = guardState.active;
  const starting = guardState.starting;
  const label = active ? "지킴이 OFF" : starting ? "연결 중" : "지킴이 ON";
  $("#guardianToggle").classList.toggle("active", active);
  $("#guardianToggle b").textContent = label;
  $("#guardStartButton").textContent = active ? "지킴이 OFF" : starting ? "카메라 연결 중..." : "지킴이 ON";
  $("#guardStartButton").disabled = starting;
  $("#guardHeroStartButton").textContent = active ? "이 노트북 지킴이 종료" : starting ? "카메라 연결 중..." : "이 노트북 지킴이 시작";
  $("#guardHeroStartButton").disabled = starting;
  $("#guardCameraStage").classList.toggle("active", active);
  $("#guardCameraPlaceholder").classList.toggle("hidden", active);
  $("#guardLiveBadge").classList.toggle("visible", active);
  $("#guardConnectionMetric").textContent = active ? "ONLINE" : "OFFLINE";
  $("#guardConnectionMetric").className = active ? "metric-ok" : "metric-off";
  $("#guardModelMetric").textContent = guardState.modelStatus;
  $("#guardPeopleMetric").textContent = `${guardState.peopleCount}명`;
  $("#guardFpsMetric").textContent = `${guardState.analysisFps.toFixed(1)} FPS`;

  if (starting) setGuardStatus("카메라 연결 중", "starting");
  else if (active) setGuardStatus("중앙 관제 연결", "online");
  else setGuardStatus("대기 중", "idle");
}

function cameraErrorMessage(error) {
  if (!window.isSecureContext) return "카메라는 HTTPS 주소에서만 사용할 수 있습니다.";
  if (error?.name === "NotAllowedError") return "카메라 권한이 차단되었습니다. 주소창의 카메라 아이콘에서 허용으로 변경하세요.";
  if (error?.name === "NotFoundError") return "사용 가능한 카메라를 찾지 못했습니다.";
  if (error?.name === "NotReadableError") return "다른 프로그램이 카메라를 사용 중입니다. Teams·Zoom·카메라 앱을 종료하세요.";
  if (error?.name === "OverconstrainedError") return "선택한 카메라를 사용할 수 없습니다. 기본 카메라로 다시 시도하세요.";
  return `카메라를 시작하지 못했습니다: ${error?.message || error}`;
}

async function populateGuardCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const select = $("#guardCameraSelect");
  const preferred = select.value || select.dataset.preferred || "";
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices.filter((device) => device.kind === "videoinput");
  select.innerHTML = `<option value="">기본 카메라</option>${cameras.map((camera, index) => `<option value="${escapeHtml(camera.deviceId)}">${escapeHtml(camera.label || `카메라 ${index + 1}`)}</option>`).join("")}`;
  if (cameras.some((camera) => camera.deviceId === preferred)) select.value = preferred;
}

function guardVideoConstraints() {
  const cameraId = $("#guardCameraSelect").value || $("#guardCameraSelect").dataset.preferred || "";
  const video = {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 20, max: 30 },
  };
  if (cameraId) video.deviceId = { exact: cameraId };
  else video.facingMode = "user";
  return { audio: false, video };
}

async function registerBrowserGuard() {
  const profile = saveGuardProfile();
  const cameraOption = $("#guardCameraSelect").selectedOptions?.[0];
  return api("/api/agents/register", {
    method: "POST",
    body: JSON.stringify({
      deviceId: getGuardDeviceId(),
      name: profile.name,
      site: profile.site,
      area: profile.area,
      cameraLabel: cameraOption?.textContent || "브라우저 웹캠",
      agentVersion: "browser-0.2",
    }),
  });
}

async function fetchBrowserGuardConfig() {
  if (!guardState.active) return;
  try {
    guardState.config = await api(`/api/devices/${encodeURIComponent(getGuardDeviceId())}/config`);
  } catch (error) {
    console.warn("config poll failed", error);
  }
}

function resizeGuardOverlay() {
  const video = $("#guardVideo");
  const canvas = $("#guardOverlay");
  if (!video.videoWidth || !video.videoHeight) return;
  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }
}

async function startBrowserGuard() {
  navigate("guard");
  if (guardState.active || guardState.starting) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    toast("이 브라우저는 카메라 기능을 지원하지 않습니다. 최신 Chrome 또는 Edge를 사용하세요.");
    return;
  }

  guardState.starting = true;
  updateGuardUi();

  try {
    const stream = await navigator.mediaDevices.getUserMedia(guardVideoConstraints());
    guardState.stream = stream;
    const video = $("#guardVideo");
    video.srcObject = stream;
    await video.play();
    if (!video.videoWidth) {
      await new Promise((resolve) => video.addEventListener("loadedmetadata", resolve, { once: true }));
    }
    resizeGuardOverlay();

    guardState.active = true;
    guardState.starting = false;
    guardState.currentRisk = "정상";
    updateGuardUi();

    await populateGuardCameras();
    const activeTrack = stream.getVideoTracks()[0];
    const activeSettings = activeTrack?.getSettings?.() || {};
    if (activeSettings.deviceId) {
      $("#guardCameraSelect").value = activeSettings.deviceId;
      saveGuardProfile();
    }

    await registerBrowserGuard();
    await fetchBrowserGuardConfig();
    startGuardTimers();
    loadGuardModel();
    setTimeout(() => uploadGuardPreview(), 900);
    setTimeout(() => sendGuardHeartbeat(), 300);
    speak("스마트 안전지킴이가 시작되었습니다.");
    toast("카메라가 중앙 관제에 연결되었습니다.");
  } catch (error) {
    guardState.starting = false;
    guardState.active = false;
    updateGuardUi();
    toast(cameraErrorMessage(error));
  }
}

async function stopBrowserGuard({ quiet = false } = {}) {
  const wasActive = guardState.active || guardState.starting;
  guardState.active = false;
  guardState.starting = false;
  clearGuardTimers();
  guardState.stream?.getTracks().forEach((track) => track.stop());
  guardState.stream = null;
  const video = $("#guardVideo");
  if (video) video.srcObject = null;
  const canvas = $("#guardOverlay");
  canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  guardState.peopleCount = 0;
  guardState.analysisFps = 0;
  guardState.currentRisk = "연결 종료";
  $("#guardPreviewMetric").textContent = "대기";
  hideGuardWarning();
  updateGuardUi();

  if (wasActive) {
    await fetch("/api/agents/offline", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: getGuardDeviceId() }),
      keepalive: true,
    }).catch(() => {});
    if (!quiet) toast("현장 지킴이를 종료했습니다.");
  }
}

async function toggleBrowserGuard() {
  if (guardState.active || guardState.starting) await stopBrowserGuard();
  else await startBrowserGuard();
}

async function restartBrowserGuardCamera() {
  if (!guardState.active) {
    saveGuardProfile();
    return;
  }
  await stopBrowserGuard({ quiet: true });
  await startBrowserGuard();
}

function clearGuardTimers() {
  for (const key of ["previewTimer", "heartbeatTimer", "configTimer", "inferenceTimer"]) {
    if (guardState[key]) clearInterval(guardState[key]);
    guardState[key] = null;
  }
}

function startGuardTimers() {
  clearGuardTimers();
  guardState.previewTimer = setInterval(uploadGuardPreview, 5000);
  guardState.heartbeatTimer = setInterval(sendGuardHeartbeat, 10000);
  guardState.configTimer = setInterval(fetchBrowserGuardConfig, 10000);
  guardState.inferenceTimer = setInterval(runGuardInference, 650);
}

function loadExternalScript(src, id) {
  const existing = document.getElementById(id);
  if (existing?.dataset.loaded === "true") return Promise.resolve();
  if (existing?.dataset.loading === "true") {
    return new Promise((resolve, reject) => {
      existing.addEventListener("load", resolve, { once: true });
      existing.addEventListener("error", reject, { once: true });
    });
  }
  return new Promise((resolve, reject) => {
    const script = existing || document.createElement("script");
    script.id = id;
    script.src = src;
    script.dataset.loading = "true";
    script.onload = () => { script.dataset.loading = "false"; script.dataset.loaded = "true"; resolve(); };
    script.onerror = () => { script.dataset.loading = "false"; reject(new Error(`스크립트 로딩 실패: ${src}`)); };
    if (!existing) document.head.appendChild(script);
  });
}

async function loadGuardAiLibraries() {
  if (!window.tf) {
    await loadExternalScript("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js", "tfjs-runtime");
  }
  if (!window.cocoSsd) {
    await loadExternalScript("https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js", "coco-ssd-runtime");
  }
}

async function loadGuardModel() {
  if (guardState.model) return guardState.model;
  if (guardState.modelLoading) return guardState.modelLoading;

  guardState.modelStatus = "로딩 중";
  updateGuardUi();
  guardState.modelLoading = (async () => {
    try {
      await loadGuardAiLibraries();
      if (!window.cocoSsd) throw new Error("브라우저 AI 라이브러리를 불러오지 못했습니다.");
      if (window.tf?.ready) await window.tf.ready();
      guardState.model = await window.cocoSsd.load({ base: "lite_mobilenet_v2" });
      guardState.modelStatus = "사람 감지 ON";
      toast("브라우저 AI 사람 감지 모델이 준비되었습니다.");
      return guardState.model;
    } catch (error) {
      console.error(error);
      guardState.modelStatus = "카메라 전송 전용";
      toast("AI 모델 로딩에 실패했지만 카메라 중앙 관제는 계속됩니다.");
      return null;
    } finally {
      guardState.modelLoading = null;
      updateGuardUi();
    }
  })();
  return guardState.modelLoading;
}

function activeGuardZones() {
  if (!$("#guardZoneEnabled")?.checked) return [];
  if (guardState.config?.rules?.dangerZone === false) return [];
  return (guardState.config?.zones || []).filter((zone) => zone.enabled !== false && Array.isArray(zone.points) && zone.points.length >= 3);
}

function pointInsidePolygon(point, polygon) {
  let inside = false;
  const [x, y] = point;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersects = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || Number.EPSILON) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function estimateGuardOverlap(box, polygon) {
  const [x1, y1, x2, y2] = box;
  let inside = 0;
  let total = 0;
  const stepsX = 5;
  const stepsY = 7;
  for (let ix = 0; ix < stepsX; ix += 1) {
    for (let iy = 0; iy < stepsY; iy += 1) {
      const px = x1 + ((ix + 0.5) / stepsX) * (x2 - x1);
      const py = y1 + ((iy + 0.5) / stepsY) * (y2 - y1);
      total += 1;
      if (pointInsidePolygon([px, py], polygon)) inside += 1;
    }
  }
  return total ? inside / total : 0;
}

function evaluateGuardDanger(people, width, height) {
  const zones = activeGuardZones();
  const dangerous = new Set();
  if (!zones.length) return dangerous;
  people.forEach((prediction, index) => {
    const [x, y, w, h] = prediction.bbox;
    const box = [x / width, y / height, (x + w) / width, (y + h) / height];
    const foot = [(x + w / 2) / width, Math.min(1, (y + h) / height)];
    const center = [(x + w / 2) / width, Math.min(1, (y + h / 2) / height)];
    const isDanger = zones.some((zone) => {
      const overlap = estimateGuardOverlap(box, zone.points);
      return pointInsidePolygon(foot, zone.points)
        || pointInsidePolygon(center, zone.points)
        || overlap >= 0.2;
    });
    if (isDanger) dangerous.add(index);
  });
  return dangerous;
}

function drawGuardOverlay(predictions = [], dangerous = new Set()) {
  const canvas = $("#guardOverlay");
  const ctx = canvas.getContext("2d");
  resizeGuardOverlay();
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  activeGuardZones().forEach((zone) => {
    const points = zone.points.map(([x, y]) => [x * canvas.width, y * canvas.height]);
    if (!points.length) return;
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    points.slice(1).forEach(([x, y]) => ctx.lineTo(x, y));
    ctx.closePath();
    ctx.fillStyle = "rgba(255, 55, 82, 0.18)";
    ctx.fill();
    ctx.strokeStyle = "#ff5268";
    ctx.lineWidth = Math.max(3, canvas.width / 360);
    ctx.stroke();
    ctx.fillStyle = "#ff7183";
    ctx.font = `${Math.max(18, canvas.width / 55)}px Segoe UI`;
    ctx.fillText(zone.name || "DANGER ZONE", points[0][0] + 10, Math.max(28, points[0][1] - 10));
  });

  predictions.forEach((prediction, index) => {
    const [x, y, w, h] = prediction.bbox;
    const isDanger = dangerous.has(index);
    ctx.strokeStyle = isDanger ? "#ff3f59" : "#50e38f";
    ctx.lineWidth = Math.max(3, canvas.width / 400);
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = isDanger ? "#ff3f59" : "#50e38f";
    ctx.font = `${Math.max(16, canvas.width / 62)}px Segoe UI`;
    ctx.fillText(`${isDanger ? "DANGER" : "PERSON"} ${(prediction.score * 100).toFixed(0)}%`, x + 4, Math.max(24, y - 8));
    ctx.beginPath();
    ctx.arc(x + w / 2, y + h, Math.max(5, canvas.width / 180), 0, Math.PI * 2);
    ctx.fill();
  });
}

async function runGuardInference() {
  if (!guardState.active || !guardState.model || guardState.inferenceBusy) return;
  const video = $("#guardVideo");
  if (video.readyState < 2 || !video.videoWidth) return;
  guardState.inferenceBusy = true;
  try {
    const started = performance.now();
    const predictions = await guardState.model.detect(video, 12, 0.48);
    const people = predictions.filter((item) => item.class === "person" && item.score >= 0.50);
    const vehicles = predictions.filter((item) => ["car", "truck", "bus", "motorcycle"].includes(item.class) && item.score >= 0.55);
    const dangerous = evaluateGuardDanger(people, video.videoWidth, video.videoHeight);

    guardState.peopleCount = people.length;
    const elapsed = performance.now() - started;
    const instantFps = elapsed > 0 ? 1000 / elapsed : 0;
    guardState.analysisFps = guardState.analysisFps ? guardState.analysisFps * 0.75 + instantFps * 0.25 : instantFps;
    drawGuardOverlay(people, dangerous);

    const now = Date.now();
    if (dangerous.size > 0) {
      guardState.currentRisk = "위험";
      if (!guardState.zoneEnteredAt) guardState.zoneEnteredAt = now;
      if (now - guardState.zoneEnteredAt >= 1000 && now - guardState.lastZoneEventAt >= 12000) {
        guardState.lastZoneEventAt = now;
        triggerGuardEvent({
          type: "DANGER_ZONE_ENTRY",
          category: "위험구역",
          severity: "high",
          message: "위험구역입니다. 즉시 이동해주세요.",
          voice: "위험구역입니다. 즉시 이동해주세요.",
        });
      }
    } else {
      guardState.zoneEnteredAt = 0;
      guardState.currentRisk = vehicles.length ? "주의" : "정상";
    }

    if (vehicles.length && guardState.config?.rules?.forklift && now - guardState.lastVehicleEventAt >= 15000) {
      guardState.lastVehicleEventAt = now;
      triggerGuardEvent({
        type: "MOBILE_EQUIPMENT_APPROACH",
        category: "중장비",
        severity: "high",
        message: "차량 또는 중장비 접근이 감지되었습니다.",
        voice: "중장비가 접근합니다. 주의하세요.",
      });
    }
    updateGuardUi();
  } catch (error) {
    console.warn("browser inference failed", error);
  } finally {
    guardState.inferenceBusy = false;
  }
}

function captureGuardCanvas(maxWidth = 640) {
  const video = $("#guardVideo");
  if (!video.videoWidth || !video.videoHeight) return null;
  const scale = Math.min(1, maxWidth / video.videoWidth);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const overlay = $("#guardOverlay");
  if (overlay.width && overlay.height) ctx.drawImage(overlay, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function canvasToBlob(canvas, quality = 0.58) {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

async function uploadGuardPreview() {
  if (!guardState.active) return;
  const canvas = captureGuardCanvas(640);
  if (!canvas) return;
  try {
    $("#guardPreviewMetric").textContent = "전송 중";
    const blob = await canvasToBlob(canvas, 0.55);
    if (!blob) throw new Error("이미지 생성 실패");
    const response = await fetch(`/api/agents/preview/${encodeURIComponent(getGuardDeviceId())}`, {
      method: "POST",
      headers: { "content-type": "image/jpeg" },
      body: blob,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    $("#guardPreviewMetric").textContent = `${new Date().toLocaleTimeString("ko-KR", { hour12: false })}`;
  } catch (error) {
    console.warn("preview upload failed", error);
    $("#guardPreviewMetric").textContent = "전송 실패";
  }
}

function browserMemoryPercent() {
  const memory = performance.memory;
  if (!memory?.jsHeapSizeLimit) return 0;
  return Math.min(100, (memory.usedJSHeapSize / memory.jsHeapSizeLimit) * 100);
}

async function sendGuardHeartbeat() {
  if (!guardState.active) return;
  try {
    await api("/api/agents/heartbeat", {
      method: "POST",
      body: JSON.stringify({
        deviceId: getGuardDeviceId(),
        fps: guardState.analysisFps,
        cpu: 0,
        memory: browserMemoryPercent(),
        peopleCount: guardState.peopleCount,
        currentRisk: guardState.currentRisk,
        agentVersion: "browser-0.2",
      }),
    });
  } catch (error) {
    console.warn("heartbeat failed", error);
    setGuardStatus("서버 재연결 중", "warning");
  }
}

function showGuardWarning(text, severity = "high") {
  const banner = $("#guardWarningBanner");
  banner.textContent = text;
  banner.className = `guard-warning-banner visible ${severity}`;
  clearTimeout(guardState.warningTimer);
  guardState.warningTimer = setTimeout(hideGuardWarning, 5200);
}

function hideGuardWarning() {
  const banner = $("#guardWarningBanner");
  if (banner) banner.className = "guard-warning-banner";
}

async function triggerGuardEvent(event) {
  if (!guardState.active) {
    toast("먼저 지킴이 ON을 눌러 카메라를 연결하세요.");
    return;
  }
  if (guardProfileFromInputs().voiceEnabled && event.voice) speak(event.voice);
  showGuardWarning(event.message, event.severity);

  const canvas = captureGuardCanvas(720);
  const snapshotBase64 = canvas ? canvas.toDataURL("image/jpeg", 0.62) : null;
  try {
    await api("/api/agents/event", {
      method: "POST",
      body: JSON.stringify({
        deviceId: getGuardDeviceId(),
        type: event.type,
        category: event.category,
        severity: event.severity,
        message: event.message,
        occurredAt: new Date().toISOString(),
        snapshotBase64,
        metadata: { source: "browser-edge", userAgent: navigator.userAgent },
      }),
    });
    await loadDashboard(true);
  } catch (error) {
    toast(`이벤트 전송 실패: ${error.message}`);
  }
}

const GUARD_TESTS = {
  helmet: {
    type: "HELMET_NOT_DETECTED",
    category: "보호구",
    severity: "medium",
    message: "안전모 미착용 확인이 필요합니다.",
    voice: "안전모를 착용해주세요.",
  },
  forklift: {
    type: "FORKLIFT_APPROACH",
    category: "중장비",
    severity: "high",
    message: "지게차 접근 주의 이벤트가 발생했습니다.",
    voice: "지게차가 지나갑니다. 주의하세요.",
  },
  zone: {
    type: "DANGER_ZONE_ENTRY",
    category: "위험구역",
    severity: "high",
    message: "위험구역 진입 확인이 필요합니다.",
    voice: "위험구역입니다. 즉시 이동해주세요.",
  },
  fall: {
    type: "FALL_CANDIDATE",
    category: "불안전 행동",
    severity: "critical",
    message: "넘어짐 의심 상황이 감지되었습니다.",
    voice: "넘어짐 위험이 감지되었습니다. 확인해주세요.",
  },
};

async function runGuardTest(kind) {
  const event = GUARD_TESTS[kind];
  if (event) await triggerGuardEvent(event);
}

async function copyGuardLink() {
  const link = `${location.origin}/guard`;
  try {
    await navigator.clipboard.writeText(link);
    toast("현장 지킴이 링크를 복사했습니다.");
  } catch {
    prompt("아래 링크를 복사하세요.", link);
  }
}

async function cleanupOfflineDevices() {
  if (!confirm("2분 이상 연결되지 않은 오프라인 장치와 해당 이벤트를 정리할까요?")) return;
  try {
    const result = await api("/api/devices/cleanup-offline", { method: "POST", body: "{}" });
    toast(`${result.deleted || 0}개 오프라인 장치를 정리했습니다.`);
    await loadDashboard();
  } catch (error) {
    toast(error.message);
  }
}

function sendOfflineBeacon() {
  if (!guardState.active || !navigator.sendBeacon) return;
  const blob = new Blob([JSON.stringify({ deviceId: getGuardDeviceId() })], { type: "application/json" });
  navigator.sendBeacon("/api/agents/offline", blob);
}


function bindEvents() {
  $$(".nav-item").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.page)));
  $$('[data-goto]').forEach((button) => button.addEventListener("click", () => navigate(button.dataset.goto)));
  $$(`[data-start-guard]`).forEach((button) => button.addEventListener("click", startBrowserGuard));
  $("#voiceTest").addEventListener("click", () => speak("스마트 안전지킴이 AI 관제 시스템이 정상 작동 중입니다."));
  $$(".speak-sample").forEach((button) => button.addEventListener("click", () => speak(button.dataset.text)));
  $("#refreshLive").addEventListener("click", () => loadDashboard());
  $("#simulateEvent").addEventListener("click", simulateEvent);
  $("#guardianToggle").addEventListener("click", toggleBrowserGuard);
  $("#guardHeroStartButton")?.addEventListener("click", toggleBrowserGuard);
  $("#guardStartButton").addEventListener("click", toggleBrowserGuard);
  $("#guardSaveProfile").addEventListener("click", async () => {
    saveGuardProfile();
    if (guardState.active) await registerBrowserGuard();
    toast("장치 정보를 저장했습니다.");
  });
  $("#guardCameraSelect").addEventListener("change", restartBrowserGuardCamera);
  $$("[data-guard-test]").forEach((button) => button.addEventListener("click", () => runGuardTest(button.dataset.guardTest)));
  $("#copyGuardLink").addEventListener("click", copyGuardLink);
  $("#copyGuardLinkSettings")?.addEventListener("click", copyGuardLink);
  $("#cleanupOfflineDevices").addEventListener("click", cleanupOfflineDevices);
  $("#zoneDeviceSelect").addEventListener("change", setupZoneEditor);
  $("#clearZone").addEventListener("click", () => { state.zonePoints = []; drawZoneCanvas(); });
  $("#saveZone").addEventListener("click", saveZone);
  const canvas = $("#zoneCanvas");
  canvas.addEventListener("click", (event) => {
    const rect = canvas.getBoundingClientRect();
    state.zonePoints.push([(event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height]);
    drawZoneCanvas();
  });
  canvas.addEventListener("contextmenu", (event) => { event.preventDefault(); state.zonePoints.pop(); drawZoneCanvas(); });
  $$(".rule-save").forEach((button) => button.addEventListener("click", () => saveRules(button)));
  $$(".rule-device-select").forEach((select) => select.addEventListener("change", () => renderRulePage(select.closest(".page").id.replace("page-", ""))));
  $("#applyEventFilter").addEventListener("click", loadEventsWithFilter);
  $("#exportEvents").addEventListener("click", exportEvents);
  $("#printReport").addEventListener("click", () => window.print());
  $("#apiOrigin").textContent = location.origin;
  navigator.mediaDevices?.addEventListener?.("devicechange", populateGuardCameras);
  window.addEventListener("beforeunload", sendOfflineBeacon);
}

function updateClock() {
  const now = new Date();
  $("#clock").innerHTML = `${now.toLocaleDateString("ko-KR",{year:"numeric",month:"2-digit",day:"2-digit"})}<br>${now.toLocaleTimeString("ko-KR",{hour12:false})}`;
}

async function init() {
  loadGuardProfileUi();
  bindEvents();
  updateGuardUi();
  updateClock();
  setInterval(updateClock, 1000);
  await loadDashboard();
  if (location.pathname === "/guard" || new URLSearchParams(location.search).get("mode") === "guard") navigate("guard");
  setInterval(() => loadDashboard(true), 5000);
}

init();
