let courses = [
  { id:"eng101", code:"ENG 101", name:"工程学导论", desc:"Engineering Fundamentals", color:"blue", count:18, progress:72, official:4, updates:"今日更新", materials:[
    {name:"第 3 章｜需求分析与问题定位", type:"课件", source:"Canvas", version:"V3.0", date:"2026.10.15", status:"official", statusText:"最新权威版", icon:"▤"},
    {name:"项目建议书评分标准", type:"作业要求", source:"Canvas", version:"V2.1", date:"2026.10.12", status:"official", statusText:"官方资料", icon:"▣"},
    {name:"答辩重点与个人分工整理", type:"复习笔记", source:"班级群", version:"V1.0", date:"2026.10.08", status:"student", statusText:"学生整理", icon:"✎"}
  ]},
  { id:"math101", code:"MATH 101", name:"高等数学 I", desc:"Advanced Mathematics", color:"orange", count:24, progress:54, official:7, updates:"2 天前", materials:[
    {name:"第 5 章｜定积分应用", type:"课件", source:"知途好课", version:"V2.0", date:"2026.10.13", status:"official", statusText:"最新权威版", icon:"▤"},
    {name:"期中复习范围说明", type:"作业要求", source:"Canvas", version:"V1.0", date:"2026.10.01", status:"official", statusText:"官方资料", icon:"▣"},
    {name:"极限与连续性错题整理", type:"复习笔记", source:"网盘", version:"V1.2", date:"2026.09.28", status:"student", statusText:"学生整理", icon:"✎"}
  ]},
  { id:"ai101", code:"AI 101", name:"人工智能导论", desc:"Introduction to AI", color:"green", count:31, progress:81, official:9, updates:"5 天前", materials:[
    {name:"第 2 章｜机器学习概览", type:"课件", source:"Canvas", version:"V4.0", date:"2026.10.10", status:"official", statusText:"最新权威版", icon:"▤"},
    {name:"第一次编程作业要求", type:"作业要求", source:"Canvas", version:"V1.1", date:"2026.10.05", status:"official", statusText:"官方资料", icon:"▣"},
    {name:"Python 环境配置避坑指南", type:"复习笔记", source:"班级群", version:"V1.0", date:"2026.09.22", status:"student", statusText:"学生整理", icon:"✎"}
  ]}
];
let alerts = [
  {title:"工程学导论 · 第 3 章课件已更新", desc:"检测到内容变更：新增“需求优先级”小节。V3.0 已成为当前权威版本。", time:"今天 09:42", course:"工程学导论", unread:true},
  {title:"工程学导论 · 项目建议书评分标准", desc:"老师更新了提交格式说明，旧版本已自动归档。", time:"昨天 16:20", course:"工程学导论", unread:true},
  {title:"高等数学 I · 期中复习范围", desc:"已确认当前版本来自 Canvas，暂无内容变更。", time:"10 月 13 日", course:"高等数学 I", unread:true},
  {title:"人工智能导论 · 机器学习概览", desc:"版本 V4.0 已同步，新增 2 个示例。", time:"10 月 10 日", course:"人工智能导论", unread:false}
];
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
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
}
function renderCourseList(){
  $("#course-list").innerHTML = courses.map(c => `<div class="course-list-item ${selectedCourse===c.id?"selected":""}" data-select-course="${c.id}">${courseDot(c.color)}<div><strong>${c.name}</strong><small>${c.count} 份资料 · ${c.official} 份官方</small></div></div>`).join("");
  renderCourseDetail();
}
function renderCourseDetail(){
  const c = courses.find(x => x.id === selectedCourse) || courses[0];
  $("#course-detail").innerHTML = `<div class="detail-head"><div><span class="course-code">${c.code}</span><h2>${c.name}</h2><p>${c.desc} · 2026 秋季学期</p></div><div class="detail-metrics"><div class="metric"><strong>${c.count}</strong><small>资料总数</small></div><div class="metric"><strong>${c.official}</strong><small>官方资料</small></div></div></div>
    <div class="material-group"><div class="group-head"><h3>最新权威资料</h3><span>默认按可信度排序</span></div>${c.materials.map(m => `<div class="material-row"><span class="material-icon">${m.icon}</span><div><strong>${m.name}</strong><small>${m.type} · ${m.source} · ${m.version} · ${m.date}${m.authorityScore ? ` · 权威度 ${Math.round(m.authorityScore*100)}%` : ""}${m.reviewStatus === "approved" ? " · 已审核" : ""}</small></div><span class="status-tag ${m.status}">${m.statusText}</span>${currentUser && ["teacher","admin"].includes(currentUser.role) ? `<button class="review-button" data-review-material="${m.id}" data-review-status="${m.reviewStatus === "approved" ? "pending" : "approved"}">${m.reviewStatus === "approved" ? "撤销审核" : "确认权威"}</button>` : ""}</div>`).join("")}</div>
    <div class="material-group"><div class="group-head"><h3>版本时间线</h3><span>可回溯 ${c.materials[0].name}</span></div><div class="timeline"><div class="timeline-item"><time>2026.10.15 · 当前</time><strong>${c.materials[0].version} ${c.materials[0].name}</strong><p>官方来源 · 内容指纹已确认变更 · 当前权威版</p></div><div class="timeline-item"><time>2026.10.08</time><strong>V2.0 ${c.materials[0].name}</strong><p>已被新版本替代 · 保留历史记录</p></div><div class="timeline-item old"><time>2026.09.21</time><strong>V1.0 ${c.materials[0].name}</strong><p>初始上传版本 · 已归档</p></div></div></div>`;
}
function renderArchive(){
  const rows = courses.flatMap(c => c.materials.map((m,i)=>({c,m,i})));
  $("#archive-rows").innerHTML = rows.map(({c,m,i}) => `<div class="archive-row"><span><strong>${m.name}</strong><small>${m.type}</small></span><span>${c.name}<small>${c.code}</small></span><span>${m.version}</span><span><em class="status-tag ${m.status}">${i===0?"当前版本":m.statusText}</em></span><span>${m.date}</span></div>`).join("");
}
function switchView(view){
  $$(".view").forEach(v => v.classList.remove("active-view"));
  $(`#${view}-view`).classList.add("active-view");
  $$(".nav-item").forEach(n => n.classList.toggle("active", n.dataset.view===view));
  $("#page-title").textContent = ({overview:"资料总览",courses:"我的课程",alerts:"变更提醒",archive:"历史归档"})[view];
  window.scrollTo({top:0,behavior:"smooth"});
}
function showToast(text){ $("#toast p").textContent=text; $("#toast").classList.add("show"); setTimeout(()=>$("#toast").classList.remove("show"),2600); }
function openModal(){ $("#material-modal").classList.add("open"); $("#material-modal").setAttribute("aria-hidden","false"); }
function closeModal(){ $("#material-modal").classList.remove("open"); $("#material-modal").setAttribute("aria-hidden","true"); }
async function loadFromApi(){
  try{
    const response = await fetch("/api/dashboard");
    if(!response.ok) throw new Error(`API ${response.status}`);
    const data = await response.json();
    courses = data.courses;
    alerts = data.alerts;
    renderCourseCards(); renderAlerts(); renderCourseList(); renderArchive();
  }catch(error){
    console.warn("API unavailable; using demo data.", error);
  }
}

async function loadCurrentUser(){
    if(!authToken) return;
    const response = await fetch("/api/auth/me", {headers:authHeaders()});
    if(response.ok){
      currentUser = (await response.json()).user;
      $("#account-button").textContent = currentUser.displayName.slice(0, 1);
      $("#account-button").title = `${currentUser.displayName} · ${currentUser.role}`;
    } else {
      authToken = "";
      localStorage.removeItem("courseTraceToken");
}
}

renderCourseCards(); renderAlerts(); renderCourseList(); renderArchive();
$$(".nav-item").forEach(b => b.addEventListener("click", () => switchView(b.dataset.view)));
$$("[data-view-target]").forEach(b => b.addEventListener("click", () => switchView(b.dataset.viewTarget)));
$$(".course-shortcut").forEach(b => b.addEventListener("click", () => { selectedCourse=b.dataset.course; renderCourseList(); switchView("courses"); }));
$("#course-list").addEventListener("click", e => { const item=e.target.closest("[data-select-course]"); if(item){selectedCourse=item.dataset.selectCourse; renderCourseList();} });
$("#course-detail").addEventListener("click", async e => { const button=e.target.closest("[data-review-material]"); if(!button) return; const status=button.dataset.reviewStatus; const note=status==="approved"?"教师确认该资料为当前权威版本":"撤销人工审核，恢复算法推荐"; const response=await fetch(`/api/materials/${button.dataset.reviewMaterial}/review`,{method:"PUT",headers:authHeaders({"Content-Type":"application/json"}),body:JSON.stringify({status,note})}); const result=await response.json(); if(!response.ok){showToast(result.message||"审核操作失败");return;} await loadFromApi(); showToast(status==="approved"?"已确认权威版本":"已撤销人工审核"); });
$("#course-cards").addEventListener("click", e => { const card=e.target.closest("[data-course-card]"); if(card){selectedCourse=card.dataset.courseCard; renderCourseList(); switchView("courses");} });
$("#global-search").addEventListener("input", e => {searchTerm=e.target.value; renderCourseCards();});
document.addEventListener("keydown", e => {if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==="k"){e.preventDefault();$("#global-search").focus();}});
$$(".filter-chip").forEach(b => b.addEventListener("click", () => { $$(".filter-chip").forEach(x=>x.classList.remove("active")); b.classList.add("active"); activeFilter=b.dataset.filter; showToast(activeFilter==="recent"?"已切换到最近更新":"已切换到"+b.textContent); }));
$("#open-alerts").addEventListener("click",()=>switchView("alerts"));
$("#mark-read").addEventListener("click",async()=>{try{const response=await fetch("/api/alerts/read",{method:"PUT",headers:authHeaders()});if(response.status===401){openLogin();return;}if(!response.ok)throw new Error(`API ${response.status}`);alerts.forEach(a=>a.unread=false);renderAlerts();showToast("所有提醒已标为已读");}catch(error){showToast("提醒状态更新失败");console.error(error);}});
$("#add-material").addEventListener("click",openModal); $("#add-course").addEventListener("click",()=>showToast("课程添加功能将在正式版开放"));
$$("[data-close-modal]").forEach(b=>b.addEventListener("click",closeModal));
$("#material-modal").addEventListener("click",e=>{if(e.target.id==="material-modal")closeModal();});
$("#material-form").addEventListener("submit",async e=>{e.preventDefault();const formData=new FormData(e.target);const endpoint=formData.get("file")?.size?"/api/materials/upload":"/api/materials";const options={method:"POST",body:endpoint.endsWith("upload")?formData:JSON.stringify(Object.fromEntries(formData)),headers:authHeaders()};if(!endpoint.endsWith("upload"))options.headers=authHeaders({"Content-Type":"application/json"});try{const response=await fetch(endpoint,options);const result=await response.json();if(response.status===401||response.status===403){closeModal();openLogin();return;}if(!response.ok)throw new Error(result.message||`API ${response.status}`);await loadFromApi();closeModal();e.target.reset();showToast(result.duplicate?"检测到重复文件，未创建新版本":"资料已加入资料库，内容指纹已生成");}catch(error){showToast(error.message||"资料保存失败");console.error(error);}});
$("#theme-toggle").addEventListener("click",()=>{document.body.classList.toggle("warm-mode");showToast("显示模式已切换");});
function openLogin(){ $("#login-modal").classList.add("open"); $("#login-modal").setAttribute("aria-hidden","false"); }
function closeLogin(){ $("#login-modal").classList.remove("open"); $("#login-modal").setAttribute("aria-hidden","true"); }
$("#account-button").addEventListener("click",()=> currentUser ? showToast(`${currentUser.displayName} · ${currentUser.role}`) : openLogin());
$$("[data-close-login]").forEach(b=>b.addEventListener("click",closeLogin));
$("#login-modal").addEventListener("click",e=>{if(e.target.id==="login-modal")closeLogin();});
$("#login-form").addEventListener("submit",async e=>{e.preventDefault();const body=Object.fromEntries(new FormData(e.target));try{const response=await fetch("/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw new Error(result.message);authToken=result.token;localStorage.setItem("courseTraceToken",authToken);currentUser=result.user;$("#account-button").textContent=currentUser.displayName.slice(0,1);$("#account-button").title=`${currentUser.displayName} · ${currentUser.role}`;closeLogin();showToast(`已登录：${currentUser.displayName}`);}catch(error){showToast(error.message||"登录失败");}});
loadFromApi(); loadCurrentUser();
