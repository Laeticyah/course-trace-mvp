// ================================================================
// 课脉 · 前端逻辑
//
// 数据源：全部来自后端 API（真实 Canvas 同步数据 + 本地上传），不再提供演示数据回退。
// ================================================================

let API_READY = false;

let courses = [];
let alerts = [];

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
let selectedCourse = "";
let searchTerm = "";
let activeFilter = "all";
let authToken = localStorage.getItem("courseTraceToken") || "";
let currentUser = null;

function authHeaders(headers = {}){
  return authToken ? {...headers, Authorization:`Bearer ${authToken}`} : headers;
}

/* HTML 转义：服务端字段（资料名/提醒/搜索词）在拼 innerHTML 前统一转义 */
function esc(value){
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* 登录态变化后重新应用“教师/管理员可见”的角色 UI（上传入口、管理后台入口等） */
function refreshRoleUI(){
  if (globalThis.Ux && typeof globalThis.Ux.applyRoleVisibility === "function") {
    globalThis.Ux.applyRoleVisibility();
  }
}

/* 侧边栏账号信息：来自当前登录用户 */
function updateProfileUI(){
  const nameEl = document.getElementById("profile-name");
  const roleEl = document.getElementById("profile-role");
  const avatar = document.querySelector(".profile .avatar");
  const roleLabels = { student: "学生", teacher: "教师", admin: "管理员" };
  if(!currentUser){
    if(nameEl) nameEl.textContent = "未登录";
    if(roleEl) roleEl.textContent = "请先登录";
    return;
  }
  if(nameEl) nameEl.textContent = currentUser.displayName;
  if(roleEl) roleEl.textContent = roleLabels[currentUser.role] || currentUser.role;
  if(avatar) avatar.textContent = currentUser.displayName.slice(0, 1);
}

/* 鉴权下载：<a> 无法携带 Bearer Token，改为 fetch + Blob */
async function downloadMaterial(materialId, fileName){
  try {
    const response = await fetch(`/api/materials/${encodeURIComponent(materialId)}/file`, { headers: authHeaders() });
    if (response.status === 401) { openLogin(); return; }
    if (!response.ok) { showToast("文件下载失败：本地未采集到该文件"); return; }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName || "material";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("开始下载：" + (fileName || "资料文件"));
  } catch (error) {
    showToast("文件下载失败");
    console.error(error);
  }
}

/* 取课程中“版本最多”的版本链（同等数量取最新），用于版本时间线与可回溯标题 */
function versionChain(course){
  const materials = (course.materials || []).slice();
  if (!materials.length) return { primary: null, chain: [] };
  const groups = new Map();
  materials.forEach(m => {
    const key = m.versionChainId || `${m.name}:${m.type}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  });
  const chains = Array.from(groups.values());
  chains.sort((a, b) =>
    b.length - a.length || String(b[0].date || "").localeCompare(String(a[0].date || "")));
  const chain = chains[0].slice().sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  const primary = chain.find(m => m.isAuthoritative && m.status !== "archived") || chain[0];
  return { primary, chain };
}

/* 版本时间线：按 versionChainId 展示真实的版本序列（替代原来的硬编码文案） */
function versionTimeline(course){
  const { primary, chain } = versionChain(course);
  if (!primary) return '<div class="empty-state">暂无版本记录</div>';
  return chain.map((m, index) => {
    const isCurrent = m.id === primary.id;
    const note = isCurrent
      ? "当前权威版 · 内容指纹已确认"
      : (m.status === "archived" ? "已被新版本替代 · 保留历史记录" : "历史版本");
    return `<div class="timeline-item${index === 0 ? "" : " old"}"><time>${esc(m.date || "")}${isCurrent ? " · 当前" : ""}</time><strong>${esc(m.version || "V1.0")} ${esc(m.name || "")}</strong><p>${esc(note)}</p></div>`;
  }).join("");
}

function courseDot(color){ return `<span class="course-dot ${color}"></span>`; }
function renderCourseCards(){
  const term = searchTerm.toLowerCase();
  const filtered = courses.filter(c => !term || `${c.name}${c.code}${c.desc}`.toLowerCase().includes(term));
  $("#course-cards").innerHTML = filtered.map(c => `<article class="course-card ${c.color}-card" data-course-card="${c.id}">
    <div class="card-top"><span class="course-code">${c.code}</span><span class="card-flag">${c.updates}</span></div>
    <h3>${c.name}</h3><p>${c.desc}</p>
    <div class="card-bottom"><div><strong>${c.count}</strong><small> 份资料</small><div class="mini-progress"><span style="width:${c.progress}%"></span></div></div><span class="arrow">↗</span></div>
  </article>`).join("") || `<div class="empty-state">没有找到匹配的课程资料</div>`;
}
function renderAlerts(){
  $("#alert-list").innerHTML = alerts.slice(0,3).map(a => `<div class="alert-item"><span class="alert-marker"></span><div><strong>${a.title}</strong><p>${a.desc}</p><time>${a.time}</time></div></div>`).join("");
  $("#alert-timeline").innerHTML = alerts.map(a => `<div class="page-alert ${a.unread ? "unread":""}"><span class="alert-marker"></span><div><strong>${a.title}</strong><p>${a.desc}</p></div><time>${a.time}</time></div>`).join("");
  // 从真实数据刷新提醒计数
  $("#nav-alert-count").textContent = alerts.filter(a => a.unread !== false).length;
  $("#alert-count").textContent = alerts.length;
}
function renderCourseList(){
  $("#course-list").innerHTML = courses.map(c => `<div class="course-list-item ${selectedCourse===c.id?"selected":""}" data-select-course="${c.id}">${courseDot(c.color)}<div><strong>${esc(c.name)}</strong><small>${c.count} 份资料 · ${c.official} 份官方</small></div></div>`).join("") || `<div class="empty-state">暂无课程，请先同步 Canvas</div>`;
  renderSidebarCourses();
  var courseCountEl = document.getElementById("course-count");
  if (courseCountEl) courseCountEl.textContent = courses.length + " 门";
  syncSidebarStats();
  renderCourseDetail();
}

/* 侧边栏课程快捷入口：来自真实课程列表，而不是静态演示数据 */
function renderSidebarCourses(){
  var container = document.getElementById("sidebar-courses");
  if (!container) return;
  container.innerHTML = courses.map(c => `<button class="course-shortcut ${selectedCourse===c.id?"selected":""}" data-course="${esc(c.id)}"><span class="course-dot ${esc(c.color || "blue")}"></span><span>${esc(c.name)}</span><small>${c.count}</small></button>`).join("") || `<button class="course-shortcut" disabled>暂无课程</button>`;
}

/* 从真实数据刷新侧边栏统计（课程数、资料总数、提醒数、归档数） */
function syncSidebarStats(){
  var totalMaterials = courses.reduce(function(sum, c){ return sum + (c.count || (c.materials||[]).length); }, 0);
  var archived = courses.reduce(function(sum, c){ return sum + (c.materials||[]).filter(function(m){ return m.status === "archived"; }).length; }, 0);
  var map = {
    "#sidebar-course-count": courses.length,
    "#sidebar-materials-count": totalMaterials,
    "#sidebar-alerts-count": alerts.length,
    "#sidebar-archived-count": archived
  };
  Object.keys(map).forEach(function(sel){
    var el = document.querySelector(sel);
    if (el) el.textContent = map[sel];
  });
  // 通用 data-count 属性刷新
  document.querySelectorAll("[data-count]").forEach(function(el){
    var key = el.getAttribute("data-count");
    if (key === "materials") el.textContent = totalMaterials;
    if (key === "courses") el.textContent = courses.length;
    if (key === "alerts") el.textContent = alerts.length;
  });
}
function renderCourseDetail(){
  if(!selectedCourse && courses[0]) selectedCourse = courses[0].id;
  const c = courses.find(x => x.id === selectedCourse) || courses[0];
  if(!c){
    $("#course-detail").innerHTML = '<div class="empty-state">暂无课程资料，请先同步 Canvas 课程</div>';
    return;
  }
  $("#course-detail").innerHTML = `<div class="detail-head"><div><span class="course-code">${c.code}</span><h2>${c.name}</h2><p>${c.desc} · 2026 秋季学期</p></div><div class="detail-metrics"><div class="metric"><strong>${c.count}</strong><small>资料总数</small></div><div class="metric"><strong>${c.official}</strong><small>官方资料</small></div></div></div>
    <div class="material-group"><div class="group-head"><h3>最新权威资料</h3><span>默认按可信度排序</span></div>${(c.materials||[]).map(m => `<div class="material-row"><span class="material-icon">${esc(m.icon || "▤")}</span><div><strong>${esc(m.name)}</strong><small>${esc(m.type)} · ${esc(m.source)} · ${esc(m.version)} · ${esc(m.date)}${m.authorityScore ? ` · 权威度 ${Math.round(m.authorityScore*100)}%` : ""}${m.reviewStatus === "approved" ? " · 已审核" : ""}</small></div><div class="material-row-actions"><span class="tag status-tag ${m.status}">${esc(m.statusText)}</span>${m.filePath ? `<button class="download-link" data-download-material="${esc(m.id)}" data-download-name="${esc(m.fileName || m.name || "material")}" title="下载已采集到本地的资料文件">下载</button>` : `<span class="download-placeholder">未采集到文件</span>`}${currentUser && ["teacher","admin"].includes(currentUser.role) ? `<button class="review-button" data-review-material="${m.id}" data-review-status="${m.reviewStatus === "approved" ? "pending" : "approved"}">${m.reviewStatus === "approved" ? "撤销审核" : "确认权威"}</button>` : ""}</div></div>`).join("")}</div>
    <div class="material-group"><div class="group-head"><h3>版本时间线</h3><span>可回溯 ${esc((versionChain(c).primary || {}).name || "资料")}</span></div><div class="timeline">${versionTimeline(c)}</div></div>`;
}
function renderArchive(){
  const rows = courses.flatMap(c => (c.materials||[]).map((m,i)=>({c,m,i})));
  $("#archive-rows").innerHTML = rows.map(({c,m,i}) => `<div class="archive-row"><span><strong>${m.name}</strong><small>${m.type}</small></span><span>${c.name}<small>${c.code}</small></span><span>${m.version}</span><span><em class="tag status-tag ${m.status}">${i===0?"当前版本":m.statusText}</em></span><span>${m.date}</span></div>`).join("");
}
function switchView(view){
  $$(".view").forEach(v => v.classList.remove("active-view"));
  $(`#${view}-view`).classList.add("active-view");
  $$(".nav-item").forEach(n => n.classList.toggle("active", n.dataset.view===view));
  $("#page-title").textContent = ({overview:"资料总览",courses:"我的课程",alerts:"变更提醒",archive:"历史归档"})[view];
  window.scrollTo({top:0,scrollBehavior:"smooth"});
}
function showToast(text){ $("#toast p").textContent=text; $("#toast").classList.add("show"); setTimeout(()=>$("#toast").classList.remove("show"),2600); }
function openModal(){
  const select = document.getElementById("material-course");
  if(select){
    select.innerHTML = courses.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("");
    if(selectedCourse) select.value = selectedCourse;
  }
  $("#material-modal").classList.add("open");
  $("#material-modal").setAttribute("aria-hidden","false");
}
function closeModal(){ $("#material-modal").classList.remove("open"); $("#material-modal").setAttribute("aria-hidden","true"); }
function openLogin(){ const modal=$("#login-modal"); if(!modal) return; modal.classList.add("open"); modal.setAttribute("aria-hidden","false"); }
function closeLogin(){ const modal=$("#login-modal"); if(!modal) return; modal.classList.remove("open"); modal.setAttribute("aria-hidden","true"); }

/* ------------------------- Canvas 同步 UI ------------------------- */
let syncPollTimer = null;

function openSyncModal(){
  const modal = $("#sync-modal");
  if(!modal) return;
  modal.classList.add("open");
  modal.setAttribute("aria-hidden","false");
}
function closeSyncModal(){
  clearInterval(syncPollTimer);
  syncPollTimer = null;
  const modal = $("#sync-modal");
  if(!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden","true");
}
function syncStatusText(job, courseName){
  const labels = { pending: "排队中", running: "同步中", success: "同步完成", failed: "同步失败", cancelled: "已取消" };
  const step = job.currentStep && !["done","failed"].includes(job.currentStep) ? ` · ${job.currentStep}` : "";
  return `${labels[job.status] || job.status} · ${courseName}${step}`;
}
function setSyncUI({ progress = 0, status = "", logs = null } = {}){
  const bar = document.getElementById("sync-progress");
  if(bar) bar.hidden = false;
  const fill = document.getElementById("sync-progress-fill");
  if(fill) fill.style.width = Math.max(0, Math.min(100, Number(progress) || 0)) + "%";
  const statusEl = document.getElementById("sync-status");
  if(statusEl && status) statusEl.textContent = status;
  if(logs) renderSyncLogs(logs);
}
function renderSyncLogs(logs){
  const el = document.getElementById("sync-log");
  if(!el) return;
  el.innerHTML = (logs || []).slice(-40).map(line => `<div class="sync-log-line"><time>${esc(String(line.createdAt || "").slice(11, 19))}</time><span class="sync-log-${esc(line.level || "info")}">${esc(line.message || "")}</span></div>`).join("");
  el.scrollTop = el.scrollHeight;
}
function pollSyncJob(jobId, courseName){
  clearInterval(syncPollTimer);
  const tick = async () => {
    try {
      const [jobRes, logRes] = await Promise.all([
        fetch(`/api/sync-jobs/${encodeURIComponent(jobId)}`, { headers: authHeaders() }),
        fetch(`/api/sync-jobs/${encodeURIComponent(jobId)}/logs`, { headers: authHeaders() })
      ]);
      if(jobRes.status === 401){ closeSyncModal(); openLogin(); return; }
      const job = jobRes.ok ? (await jobRes.json()).job : null;
      const logs = logRes.ok ? ((await logRes.json()).logs || []) : [];
      if(!job) return;
      setSyncUI({ progress: job.progress || 0, status: syncStatusText(job, courseName), logs });
      if(["success","failed","cancelled"].includes(job.status)){
        clearInterval(syncPollTimer);
        syncPollTimer = null;
        if(job.status === "success"){
          await loadFromApi();
          showToast(`「${courseName}」同步完成`);
        }else{
          showToast("同步失败：" + (job.error || "未知错误"));
        }
      }
    } catch (error) {
      // 网络抖动时保留轮询，下一次继续
    }
  };
  tick();
  syncPollTimer = setInterval(tick, 600);
}
async function runCourseSync(courseId){
  if(!currentUser || !["teacher","admin"].includes(currentUser.role)){
    showToast("请先用教师或管理员账号登录");
    return;
  }
  const course = courses.find(item => item.id === courseId) || courses[0];
  if(!course){ showToast("没有可同步的课程"); return; }
  openSyncModal();
  setSyncUI({ progress: 0, status: `正在为「${course.name}」创建同步任务…`, logs: [] });
  try {
    const response = await fetch(`/api/courses/${encodeURIComponent(course.id)}/sync`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: "{}"
    });
    if(response.status === 401){ closeSyncModal(); openLogin(); return; }
    const result = await response.json().catch(() => ({}));
    if(!response.ok){
      setSyncUI({ status: result.message || "同步任务创建失败" });
      showToast(result.message || "同步任务创建失败");
      return;
    }
    pollSyncJob(result.job.id, course.name);
  } catch (error) {
    setSyncUI({ status: "同步任务创建失败：" + error.message });
    showToast("同步任务创建失败");
  }
}

/* 标记数据已就绪：供骨架屏等增强层轮询使用（window.__apiReady） */
function markReady(){ window.__apiReady = true; }

/**
 * 从后端 API 加载数据（统一数据源入口）
 * 返回 { courses, alerts }
 */
async function fetchFromApi() {
  const response = await fetch("/api/dashboard", { headers: authHeaders() });
  if (!response.ok) throw new Error(`API ${response.status}`);
  return await response.json();
}

/**
 * 加载数据主流程：
 *   1. 优先从 API 获取
 *   2. 失败时：开发模式可回退 mock，生产模式显示错误提示
 */
async function loadFromApi(){
  try{
    const data = await fetchFromApi();
    API_READY = true;
    courses = data.courses || [];
    alerts = data.alerts || [];
    hideApiError();
  }catch(error){
    console.warn("[load] API unavailable:", error.message);
    showApiError(error.message);
    markReady();
    return;
  }
  if(courses.length && !courses.some(c => c.id === selectedCourse)) selectedCourse = courses[0].id;
  renderCourseCards(); renderAlerts(); renderCourseList(); renderArchive();
  markReady();
}

function showApiError(message) {
  const el = document.getElementById("api-error");
  if (!el) return;
  el.textContent = "⚠️ 数据加载失败：" + (message || "未知错误") + "，请检查服务状态";
  el.hidden = false;
}

function hideApiError() {
  const el = document.getElementById("api-error");
  if (!el) return;
  el.hidden = true;
}

async function loadCurrentUser(){
    if(!authToken) return;
    const response = await fetch("/api/auth/me", {headers:authHeaders()});
    if(response.ok){
      currentUser = (await response.json()).user;
      $("#account-button").textContent = currentUser.displayName.slice(0, 1);
      $("#account-button").title = `${currentUser.displayName} · ${currentUser.role}`;
      const loginHint = document.getElementById("login-hint");
      if (loginHint) loginHint.hidden = true;
      updateProfileUI();
      refreshRoleUI();
    } else {
      authToken = "";
      localStorage.removeItem("courseTraceToken");
      localStorage.removeItem("courseToken");
    }
}

// 初始化（保留原有 boot 逻辑）
renderCourseCards(); renderAlerts(); renderCourseList(); renderArchive();
$$(".nav-item").forEach(b => b.addEventListener("click", () => switchView(b.dataset.view)));
$$("[data-view-target]").forEach(b => b.addEventListener("click", () => switchView(b.dataset.viewTarget)));
var sidebarCoursesEl = document.getElementById("sidebar-courses");
if(sidebarCoursesEl){
  sidebarCoursesEl.addEventListener("click", e => {
    const btn = e.target.closest("[data-course]");
    if(!btn) return;
    selectedCourse = btn.dataset.course;
    renderCourseList();
    switchView("courses");
  });
}
$("#course-list").addEventListener("click", e => { const item=e.target.closest("[data-select-course]"); if(item){selectedCourse=item.dataset.course; renderCourseList();} });
$("#course-detail").addEventListener("click", async e => {
  const downloadButton = e.target.closest("[data-download-material]");
  if(downloadButton){
    e.preventDefault();
    await downloadMaterial(downloadButton.dataset.downloadMaterial, downloadButton.dataset.downloadName);
    return;
  }
  const button=e.target.closest("[data-review-material]");
  if(!button) return;
  const status=button.dataset.reviewStatus;
  const note=status==="approved"?"教师确认该资料为当前权威版本":"撤销人工审核，恢复算法推荐";
  const response=await fetch(`/api/materials/${button.dataset.reviewMaterial}/review`,{method:"PUT",headers:authHeaders({"Content-Type":"application/json"}),body:JSON.stringify({status,note})});
  const result=await response.json();
  if(!response.ok){showToast(result.message||"审核操作失败");return;}
  await loadFromApi();
  showToast(status==="approved"?"已确认权威版本":"已撤销人工审核");
});
$("#course-cards").addEventListener("click", e => { const card=e.target.closest("[data-course-card]"); if(card){selectedCourse=card.dataset.courseCard; renderCourseList(); switchView("courses");} });
$("#global-search").addEventListener("input", e => {
  const q = e.target.value.trim();
  const debounce = window.__searchTimer;
  clearTimeout(debounce);
  window.__searchTimer = setTimeout(async () => {
    searchTerm = q;
    if (q.length >= 2) {
      // 调用后端 FITS5 搜索 API
      try {
        const resp = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=20`, {headers: authHeaders()});
        if (resp.ok) {
          const data = await resp.json();
          renderSearchResults(data.results || []);
          return;
        }
      } catch(err) { console.warn("[search] API error:", err.message); }
    }
    // 回退到本地过滤
    renderCourseCards();
  }, 300);
});
function renderSearchResults(results){
  const container = $("#course-cards");
  if (!container) return;
  if (!results.length) {
    container.innerHTML = `<div class="empty-state">没有找到与“${searchTerm}”匹配的课程资料</div>`;
    return;
  }
  container.innerHTML = results.map(r => `<article class="course-card ${r.color||"blue"}-card">
    <div class="card-top"><span class="course-code">${r.courseCode || ""}</span><span class="flag tag status-tag ${r.status || ""}">${r.statusText || ""}</span></div>
    <h3>${r.name}</h3>
    <p>${r.courseName || ""} · ${r.type || ""} · ${r.source || ""}</p>
    <small>权威度 ${r.authorityScore ? Math.round(r.authorityScore*100)+"%" : "—"}</small>
  </article>`).join("");
}
document.addEventListener("keydown", e => {if((e.ctrlKey || e.metaKey) && e.key.toLowerCase()==="k"){e.preventDefault();$("#global-search").focus();}});
$$(".filter-chip").forEach(b => b.addEventListener("click", () => { $$(".filter-chip").forEach(x=>x.classList.remove("active")); b.classList.add("active"); activeFilter=b.dataset.filter; showToast(activeFilter==="recent"?"已切换到最近更新":"已切换到"+b.textContent); }));
$("#open-alerts").addEventListener("click",()=>switchView("alerts"));
$("#mark-read").addEventListener("click",async()=>{try{const response=await fetch("/api/alerts/read",{method:"PUT",headers:authHeaders()});if(response.status===401){openLogin();return;}if(!response.ok)throw new Error(`API ${response.status}`);alerts.forEach(a=>a.unread=false);renderAlerts();showToast("所有提醒已读");}catch(error){showToast("提醒状态更新失败");console.error(error);}});
$("#add-material").addEventListener("click",openModal); $("#add-course").addEventListener("click",()=>showToast("课程添加功能将在正式版开放"));
$("#sync-btn") && $("#sync-btn").addEventListener("click",()=>runCourseSync(selectedCourse));
$("#sync-close") && $("#sync-close").addEventListener("click",closeSyncModal);
$("#sync-modal") && $("#sync-modal").addEventListener("click",e=>{if(e.target.id==="sync-modal")closeSyncModal();});
$$("[data-close-modal]").forEach(b=>b.addEventListener("click",()=>{ if(b.closest("#sync-modal")) closeSyncModal(); else closeModal(); }));
$("#material-modal").addEventListener("click",e=>{if(e.target.id==="material-modal")closeModal();});
$("#material-form").addEventListener("submit", async e=>{
  e.preventDefault();
  const formData=new FormData(e.target);
  const endpoint=formData.get("file")?.size?"/api/materials/upload":"/api/materials";
  const options={method:"POST",body:endpoint.endsWith("upload")?formData:JSON.stringify(Object.fromEntries(formData)),headers:authHeaders()};
  if(!endpoint.endsWith("upload")) options.headers=authHeaders({"Content-Type":"application/json"});
  try {
    const response=await fetch(endpoint,options);
    const result=await response.json();
    if(response.status===401||response.status===403){closeModal();openLogin();return;}
    if(!response.ok){showToast(result.message||"资料保存失败");return;}
    showToast("资料已加入资料库，内容指纹已生成 ✓");
    closeModal();
    await loadFromApi();
  }catch(error){
    showToast(error.message||"资料保存失败");
    console.error(error);
  }
});
$("#login-form").addEventListener("submit", async e=>{
  e.preventDefault();
  const body=Object.fromEntries(new FormData(e.target));
  try {
    const response=await fetch("/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    const result=await response.json();
    if(!response.ok){showToast(result.message||"登录失败");return;}
    authToken=result.token;
    localStorage.setItem("courseTraceToken",result.token);
    const loginHint=document.getElementById("login-hint");
    if(loginHint) loginHint.hidden=true;
    currentUser=result.user;
    $("#account-button").textContent=result.user.displayName.slice(0,1);
    $("#account-button").title=`${result.user.displayName} · ${result.user.role}`;
    updateProfileUI();
    refreshRoleUI();
    closeLogin();
    showToast(`已登录：${result.user.displayName}`);
    await loadFromApi();
    await loadCurrentUser();
  } catch(error) {
    showToast(error.message||"登录失败");
    console.error(error);
  }
});

/* 登录层：头像入口、关闭按钮、遮罩点击 */
$("#account-button").addEventListener("click",()=> currentUser ? showToast(`${currentUser.displayName} · ${currentUser.role}`) : openLogin());
$$("[data-close-login]").forEach(b=>b.addEventListener("click",closeLogin));
$$("[data-open-login]").forEach(b=>b.addEventListener("click",openLogin));
$("#login-modal").addEventListener("click",e=>{if(e.target.id==="login-modal")closeLogin();});

async function boot(){
  if(!authToken){
    markReady();
    openLogin();
    return;
  }
  document.body.classList.add("authenticated");
  await loadCurrentUser();
  await loadFromApi();
}

boot();
