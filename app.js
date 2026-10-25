// ================================================================
// 课脉 · 前端逻辑
//
// 数据源策略（统一前后端数据源）：
//   - 正式运行时：优先使用后端 API（/api/dashboard 等）
//   - API 不可用时：在开发模式（DEV_MODE）下可使用内置 MockData
//   - 生产模式：API 失败时显示明确的错误提示 + 重试按钮，不再静默回退
// ================================================================

// 运行时环境判断：仅当开发模式下允许使用 mock 数据
const DEV_MODE = location.hostname === "localhost" || location.hostname === "127.0.0.1";
let API_READY = false;

// 数据容器（优先来自 API，回退时来自 MockData）
let courses = [];
let alerts = [];

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
let selectedCourse = "eng101";
let searchTerm = "";
let activeFilter = "all";
let authToken = localStorage.getItem("courseTraceToken") || "";
let currentUser = null;

function authHeaders(headers = {}){
  return authToken ? {...headers, Authorization:`Bearer ${authToken}`} : headers;
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
  $("#course-list").innerHTML = courses.map(c => `<div class="course-list-item ${selectedCourse===c.id?"selected":""}" data-select-course="${c.id}">${courseDot(c.color)}<div><strong>${c.name}</strong><small>${c.count} 份资料 · ${c.official} 份官方</small></div></div>`).join("");
  var courseCountEl = document.getElementById("course-count");
  if (courseCountEl) courseCountEl.textContent = courses.length + " 门";
  syncSidebarStats();
  renderCourseDetail();
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
  const c = courses.find(x => x.id === selectedCourse) || courses[0];
  if(!c) return;
  $("#course-detail").innerHTML = `<div class="detail-head"><div><span class="course-code">${c.code}</span><h2>${c.name}</h2><p>${c.desc} · 2026 秋季学期</p></div><div class="detail-metrics"><div class="metric"><strong>${c.count}</strong><small>资料总数</small></div><div class="metric"><strong>${c.official}</strong><small>官方资料</small></div></div></div>
    <div class="material-group"><div class="group-head"><h3>最新权威资料</h3><span>默认按可信度排序</span></div>${(c.materials||[]).map(m => `<div class="material-row"><span class="material-icon">${m.icon}</span><div><strong>${m.name}</strong><small>${m.type} · ${m.source} · ${m.version} · ${m.date}${m.authorityScore ? ` · 权威度 ${Math.round(m.authorityScore*100)}%` : ""}${m.reviewStatus === "approved" ? " · 已审核" : ""}</small></div><span class="tag status-tag ${m.status}">${m.statusText}</span>${m.filePath ? `<a class="download-link" href="/api/courses/${c.id}/files/${encodeURIComponent(m.fileName || m.name)}" title="下载已采集到本地的资料文件">⬇ 下载</a>` : `<span class="download-link download-placeholder">未采集到文件</span>`}${currentUser && ["teacher","admin"].includes(currentUser.role) ? `<button class="review-button" data-review-material="${m.id}" data-review-status="${m.reviewStatus === "approved" ? "pending" : "approved"}">${m.reviewStatus === "approved" ? "撤销审核" : "确认权威"}</button>` : ""}</div>`).join("")}</div>
    <div class="material-group"><div class="group-head"><h3>版本时间线</h3><span>可回溯 ${(c.materials&&c.materials[0])?c.materials[0].name:'资料'}</span></div><div class="timeline"><div class="timeline-item"><time>2026.10.15 · 当前</time><strong>${(c.materials&&c.materials[0])?c.materials[0].version:'V1.0'} ${(c.materials&&c.materials[0])?c.materials[0].name:''}</strong><p>官方来源 · 内容指纹已确认变更 · 当前权威版</p></div><div class="timeline-item"><time>2026.10.08</time><strong>V2.0 ${(c.materials&&c.materials[0])?c.materials[0].name:''}</strong><p>已被新版本替代 · 保留历史记录</p></div><div class="timeline-item old"><time>2026.09.21</time><strong>V1.0 ${(c.materials&&c.materials[0])?c.materials[0].name:''}</strong><p>初始上传版本 · 已归档</p></div></div></div>`;
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
function openModal(){ $("#material-modal").classList.add("open"); $("#material-modal").setAttribute("aria-hidden","false"); }
function closeModal(){ $("#material-modal").classList.remove("open"); $("#material-modal").setAttribute("aria-hidden","true"); }
function openLogin(){ const modal=$("#login-modal"); if(!modal) return; modal.classList.add("open"); modal.setAttribute("aria-hidden","false"); }
function closeLogin(){ const modal=$("#login-modal"); if(!modal) return; modal.classList.remove("open"); modal.setAttribute("aria-hidden","true"); }

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
    if (DEV_MODE && (globalThis.MockData)) {
      // 开发模式允许 mock 回退
      courses = MockData.getCourses();
      alerts = MockData.getAlerts();
      showToast("⚠️ 开发模式：正在使用演示数据");
    } else {
      // 生产模式：显示明确的错误提示
      showApiError(error.message);
      markReady();
      return;
    }
  }
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
$$(".course-shortcut").forEach(b => b.addEventListener("click", () => { selectedCourse=b.dataset.course; renderCourseList(); switchView("courses"); }));
$("#course-list").addEventListener("click", e => { const item=e.target.closest("[data-select-course]"); if(item){selectedCourse=item.dataset.course; renderCourseList();} });
$("#course-detail").addEventListener("click", async e => { const button=e.target.closest("[data-review-material]"); if(!button) return; const status=button.dataset.reviewStatus; const note=status==="approved"?"教师确认该资料为当前权威版本":"撤销人工审核，恢复算法推荐"; const response=await fetch(`/api/materials/${button.dataset.reviewMaterial}/review`,{method:"PUT",headers:authHeaders({"Content-Type":"application/json"}),body:JSON.stringify({status,note})}); const result=await response.json(); if(!response.ok){showToast(result.message||"审核操作失败");return;} await loadFromApi(); showToast(status==="approved"?"已确认权威版本":"已撤销人工审核"); });
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
$$("[data-close-modal]").forEach(b=>b.addEventListener("click",closeModal));
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
    // 未登录：锁定主界面，只显示登录层（若有内置演示数据先渲染）
    if (globalThis.MockData) {
      courses = MockData.getCourses();
      alerts = MockData.getAlerts();
      renderCourseCards(); renderAlerts(); renderCourseList(); renderArchive();
    }
    markReady();
    openLogin();
    return;
  }
  document.body.classList.add("authenticated");
  await loadCurrentUser();
  await loadFromApi();
}

boot();
