const express = require("express");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const canvas = require("./canvas");
const {
  readData, writeData, createSession, findUserByCredentials,
  findUserByToken, deleteSession, reviewMaterial, getMembership,
  listUserCourses, listCourseMembers, addCourseMember, removeCourseMember,
  searchMaterials, getMaterialDetail, recordMaterialVersion,
  isTeacherOrAdmin, canAccessCourse, syncFTSIndex,
  setArchived, removeMaterial,
  createSyncJob, getSyncJob, listSyncJobs, updateSyncJob,
  appendSyncJobLog, getSyncJobLogs, requireSyncJobAccess
} = require("./database");
const syncEngine = require("./sync-engine");

const app = express();
const port = Number(process.env.PORT || 4173);
const execFileAsync = promisify(execFile);
const uploadDir = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(__dirname, "uploads");
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 25 * 1024 * 1024 }
});

const seed = {
  courses: [
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
  ],
  alerts: [
    {title:"工程学导论 · 第 3 章课件已更新", desc:"检测到内容变更：新增“需求优先级”小节。V3.0 已成为当前权威版本。", time:"今天 09:42", course:"工程学导论", unread:true},
    {title:"工程学导论 · 项目建议书评分标准", desc:"老师更新了提交格式说明，旧版本已自动归档。", time:"昨天 16:20", course:"工程学导论", unread:true},
    {title:"高等数学 I · 期中复习范围", desc:"已确认当前版本来自 Canvas，暂无内容变更。", time:"10 月 13 日", course:"高等数学 I", unread:true},
    {title:"人工智能导论 · 机器学习概览", desc:"版本 V4.0 已同步，新增 2 个示例。", time:"10 月 10 日", course:"人工智能导论", unread:false}
  ]
};

/* 静态资源白名单：只对外暴露前端页面与脚本，源码 / 数据库 / 上传文件不再走静态托管 */
const PUBLIC_FILES = new Set([
  "/", "/index.html", "/styles.css", "/app.js",
  "/mock-data.js", "/enhancements.js", "/ux-polish.js"
]);

function sanitizeFileName(name){
  const base = path.basename(String(name || "file")).replace(/[\\/:*?"<>|]/g, "_").replace(/^\.+/, "_");
  return base.slice(0, 120) || "file";
}

/* 新版本入库前，把同一版本链上的旧资料标记为已归档 */
function archivePreviousVersions(course, chainId){
  for(const item of course.materials || []){
    if(item.versionChainId === chainId && item.status !== "archived"){
      item.status = "archived";
      item.statusText = "已归档";
    }
  }
}

function findMaterialById(data, materialId){
  for(const course of data.courses || []){
    const material = (course.materials || []).find(item => item.id === materialId);
    if(material) return { course, material };
  }
  return null;
}

/* 校验并解析上传目录内的文件（防止越权读取项目内其它文件）
 * 兼容两种库内路径：相对项目根目录（uploads/...）与绝对路径；
 * 设置 UPLOAD_DIR 时，把旧的 uploads/ 前缀映射到新的上传目录。 */
function resolveUploadPath(filePath){
  if(!filePath) return null;
  const root = path.resolve(uploadDir);
  const candidates = [];
  if(path.isAbsolute(filePath)){
    candidates.push(path.resolve(filePath));
  }else{
    candidates.push(path.resolve(__dirname, filePath));
    const normalized = String(filePath).replace(/\\/g, "/");
    if(normalized === "uploads" || normalized.startsWith("uploads/")){
      const suffix = normalized.slice("uploads".length).replace(/^\//, "");
      candidates.push(path.resolve(uploadDir, suffix));
    }
  }
  for(const absolute of candidates){
    if(absolute === root || absolute.startsWith(root + path.sep)) return absolute;
  }
  return null;
}

function normalizeMaterial(input){
  const official = input.source === "Canvas" || input.source === "知途好课";
  return {
    id: crypto.randomUUID(),
    name: String(input.name || "").trim(),
    type: String(input.type || "课件"),
    source: String(input.source || "班级群"),
    version: "V1.0",
    date: new Date().toISOString().slice(0, 10).replaceAll("-", "."),
    status: official ? "official" : "student",
    statusText: official ? "最新权威版" : "学生整理",
    icon: "▤",
    fileHash: input.fileHash || null,
    fileName: input.fileName || null,
    fileSize: input.fileSize || null,
    filePath: input.filePath || null,
    versionChainId: input.versionChainId || crypto.randomUUID(),
    authorityScore: 0,
    authorityBreakdown: null,
    isAuthoritative: false
  };
}

function nextVersion(materials, name, type){
  const versions = materials
    .filter(item => item.name === name && item.type === type)
    .map(item => Number.parseInt(String(item.version || "V0").replace("V", ""), 10) || 0);
  return `V${Math.max(0, ...versions) + 1}.0`;
}

async function sha256(filePath){
  const hash = crypto.createHash("sha256");
  const content = await fs.readFile(filePath);
  hash.update(content);
  return hash.digest("hex");
}

function normalizeText(value){
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function textFingerprint(text){
  return crypto.createHash("sha256").update(normalizeText(text).toLowerCase()).digest("hex");
}

function structureFeatures(text){
  const normalized = normalizeText(text);
  const headings = (normalized.match(/(?:第\s*[一二三四五六七八九十\d]+\s*[章节]|chapter\s*\d+|[一二三四五六七八九十\d]+\s*[、.])/gi) || []).length;
  const words = normalized ? normalized.split(/\s+/).length : 0;
  return { characters: normalized.length, words, headings };
}

async function extractOfficeText(filePath, extension){
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    `$path = $args[0]; Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip = [IO.Compression.ZipFile]::OpenRead($path); $parts = if ("${extension}" -eq ".docx") { $zip.Entries | Where-Object { $_.FullName -eq "word/document.xml" } } else { $zip.Entries | Where-Object { $_.FullName -match "^ppt/slides/slide\\d+\\.xml$" } }; foreach($part in $parts) { $reader = [IO.StreamReader]::new($part.Open()); $xml = $reader.ReadToEnd(); $reader.Dispose(); [regex]::Matches($xml, "<a:t[^>]*>(.*?)</a:t>|<w:t[^>]*>(.*?)</w:t>") | ForEach-Object { if($_.Groups[1].Value) { $_.Groups[1].Value } else { $_.Groups[2].Value } } }; $zip.Dispose()`,
    filePath
  ]);
  return normalizeText(stdout);
}

async function extractDocumentFeatures(filePath, originalName = filePath){
  const extension = path.extname(originalName).toLowerCase();
  let text = "";
  if(extension === ".pdf"){
    const parsed = await pdfParse(await fs.readFile(filePath));
    text = parsed.text;
  } else if(extension === ".docx" || extension === ".pptx"){
    text = await extractOfficeText(filePath, extension);
  } else if(extension === ".txt"){
    text = await fs.readFile(filePath, "utf8");
  }
  return { text: normalizeText(text), textHash: textFingerprint(text), structure: structureFeatures(text) };
}

function similarityScore(left, right){
  if(!left || !right) return 0;
  if(left.textHash && left.textHash === right.textHash) return 1;
  const a = new Set(normalizeText(left.text).toLowerCase().split(/\s+/).filter(Boolean));
  const b = new Set(normalizeText(right.text).toLowerCase().split(/\s+/).filter(Boolean));
  if(!a.size || !b.size) return 0;
  let overlap = 0;
  for(const token of a) if(b.has(token)) overlap += 1;
  return overlap / new Set([...a, ...b]).size;
}

const sourceAuthority = {
  Canvas: 1,
  "知途好课": 0.92,
  "教师上传": 0.95,
  "班级群": 0.58,
  网盘: 0.48,
  转发: 0.4
};

function parseDate(value){
  const parsed = new Date(String(value || "").replaceAll(".", "-"));
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

function calculateAuthority(material, chain){
  // —— 五因子可信度加权（来源×35% + 时间×20% + 变更×15% + 审核×20% + 完整度×10%）
  const sourceScore = sourceAuthority[material.source] ?? 0.35;
  const newest = Math.max(...chain.map(item => parseDate(item.date).getTime()), Date.now());
  const ageDays = Math.max(0, (newest - parseDate(material.date).getTime()) / 86400000);
  const freshnessScore = Math.exp(-ageDays / 30);
  const similarity = Number(material.similarity ?? 0);
  const changeScore = material.extractedText
    ? Math.min(1, Math.max(0.1, 1 - similarity))
    : 0.55;

  // 教师审核因子：approved → 1，否则 0（默认 pending=0 → 不加分也不扣分）
  const reviewScore = material.reviewStatus === "approved" ? 1 : 0;
  // 内容完整度因子：显式提供则用，否则按文件大小粗略估计（≥100KB→1）
  const rawComplete = clamp01(material.completeness);
  const completenessScore = material.completeness != null
    ? rawComplete
    : material.fileSize ? Math.min(1, Math.max(0.2, material.fileSize / (100 * 1024))) : 0.35;

  const parts = {
    source: { score: sourceScore, weight: 0.35, label: "来源权威度", detail: `来自 ${material.source}，可信度 ${Math.round(sourceScore * 100)}%` },
    freshness: { score: freshnessScore, weight: 0.20, label: "时间新度", detail: ageDays < 1 ? "今天更新" : `${Math.round(ageDays)} 天前更新` },
    change: { score: changeScore, weight: 0.15, label: "内容变更度", detail: `与上一版本相似度 ${Math.round(similarity * 100)}%` },
    review: { score: reviewScore, weight: 0.20, label: "教师审核", detail: reviewScore ? "已确认，+20%" : "待确认，无加分" },
    completeness: { score: completenessScore, weight: 0.10, label: "内容完整度", detail: material.fileSize ? `文件 ${(material.fileSize / 1024).toFixed(0)}KB，约 ${Math.round(completenessScore * 100)}% 完整` : "未提供文件，估测 35%" },
  };

  const score = Object.values(parts).reduce((sum, p) => sum + p.score * p.weight, 0);

  return {
    score: Number(score.toFixed(3)),
    parts,
    breakdown: Object.values(parts)
      .map(p => ({ label: p.label, value: Number((p.score * p.weight).toFixed(3)), detail: p.detail }))
      .sort((a, b) => b.value - a.value),
  };
}

function clamp01(x){
  if (x == null || Number.isNaN(Number(x))) return 0.5;
  return Math.min(1, Math.max(0, Number(x)));
}

function applyAuthority(courses){
  for(const course of courses){
    const chains = new Map();
    for(const material of course.materials){
      const chainId = material.versionChainId || `${material.name}:${material.type}`;
      if(!chains.has(chainId)) chains.set(chainId, []);
      chains.get(chainId).push(material);
    }
    for(const chain of chains.values()){
      const scored = chain.map(material => ({ material, breakdown: calculateAuthority(material, chain) }));
      // 已归档版本不参与“当前权威版”评选
      const active = scored.filter(item => item.material.status !== "archived");
      const approved = active
        .filter(item => item.material.reviewStatus === "approved")
        .sort((a, b) => parseDate(b.material.date) - parseDate(a.material.date))[0];
      const authoritative = approved || active.reduce((best, item) =>
        !best || item.breakdown.score > best.breakdown.score ? item : best, null);
      for(const { material, breakdown } of scored){
        material.authorityScore = breakdown.score;
        material.authorityBreakdown = breakdown;
        if(material.status === "archived"){
          material.isAuthoritative = false;
          material.statusText = "已归档";
          continue;
        }
        material.isAuthoritative = Boolean(authoritative && material.id === authoritative.material.id);
        if(material.status === "official"){
          material.statusText = material.isAuthoritative ? "最新权威版" : "官方历史版";
        } else {
          material.statusText = "学生整理";
        }
      }
    }
  }
  return courses;
}

app.use(express.json({ limit: "1mb" }));
// 只放行前端资源白名单；/api/* 交给路由处理，其余一律 404
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  if (!PUBLIC_FILES.has(req.path)) return res.status(404).type("text/plain").send("Not Found");
  next();
});
app.use(express.static(__dirname, { index: "index.html", dotfiles: "ignore" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "course-trace-api", time: new Date().toISOString() });
});

function currentUser(req) {
  const header = req.get("authorization") || "";
  return findUserByToken(header.startsWith("Bearer ") ? header.slice(7) : "");
}

function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "UNAUTHENTICATED", message: "请先登录" });
  req.user = user;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: "FORBIDDEN", message: "当前账号没有执行此操作的权限" });
    next();
  };
}

app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "INVALID_CREDENTIALS", message: "用户名和密码不能为空" });
  const user = findUserByCredentials(username, password);
  if (!user) return res.status(401).json({ error: "INVALID_CREDENTIALS", message: "用户名或密码错误" });
  const session = createSession(user.id);
  res.json({ user, ...session });
});

app.get("/api/auth/me", requireAuth, (req, res) => res.json({ user: req.user }));

app.post("/api/auth/logout", requireAuth, (req, res) => {
  const header = req.get("authorization") || "";
  deleteSession(header.slice(7));
  res.status(204).end();
});

function canViewCourse(user, courseId) {
  // 安全修复：移除匿名访问(原先 !user 直接放行)。
  // 管理员和教师可查看全部课程资料；学生需加入该课程。
  if (!user) return false;
  if (user.role === "admin") return true;
  if (user.role === "teacher") return true;
  return Boolean(getMembership(courseId, user.id));
}

app.get("/api/dashboard", requireAuth, async (_req, res, next) => {
  try {
    const user = currentUser(_req);
    const data = readData();
    if (user?.role === "student") {
      const joined = new Set(listUserCourses(user.id).map(course => course.id));
      data.courses = data.courses.filter(course => joined.has(course.id));
      data.alerts = data.alerts.filter(alert => data.courses.some(course => course.name === alert.course));
    }
    applyAuthority(data.courses);
    res.json(data);
  } catch(error) { next(error); }
});

app.get("/api/courses", requireAuth, async (req, res, next) => {
  try {
    const data = readData();
    const keyword = String(req.query.q || "").toLowerCase();
    const courses = keyword
      ? data.courses.filter(course => `${course.name}${course.code}${course.desc}`.toLowerCase().includes(keyword))
      : data.courses;
    applyAuthority(courses);
    res.json({ courses });
  } catch(error) { next(error); }
});

app.get("/api/courses/:courseId/materials", requireAuth, async (req, res, next) => {
  try {
    const user = currentUser(req);
    if (!canViewCourse(user, req.params.courseId)) return res.status(403).json({ error: "COURSE_ACCESS_DENIED", message: "请先加入该课程" });
    const data = readData();
    const course = data.courses.find(item => item.id === req.params.courseId);
    if(!course) return res.status(404).json({ error: "COURSE_NOT_FOUND", message: "课程不存在" });
    applyAuthority([course]);
    res.json({ course, materials: course.materials });
  } catch(error) { next(error); }
});

// 全文搜索资料 - 需要登录且只能看到有权限访问的课程资料
app.get("/api/search", requireAuth, (req, res, next) => {
  try {
    const q = String(req.query.q || "").trim();
    const courseId = String(req.query.course_id || "").trim() || undefined;
    const type = String(req.query.type || "").trim() || undefined;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);

    const user = currentUser(req);
    const data = readData();

    // 构建权限过滤：学生只能看已加入的课程；教师/管理员可看全部
    let allowedCourseIds = null;
    if (user?.role === "student") {
      allowedCourseIds = listUserCourses(user.id).map(c => c.id);
    }

    const results = searchMaterials({ q, courseId, type, user, limit });

    // 额外按课程权限过滤（学生无法访问未加入课程的搜索结果）
    let filtered = results;
    if (allowedCourseIds) {
      filtered = results.filter(r => allowedCourseIds.includes(r.courseId));
    }

    res.json({
      query: { q, courseId, type, limit },
      count: filtered.length,
      results: filtered
    });
  } catch (error) { next(error); }
});

// 单个资料详情 + 版本时间线
app.get("/api/materials/:materialId", requireAuth, (req, res, next) => {
  try {
    const user = currentUser(req);
    const detail = getMaterialDetail(req.params.materialId, user);
    if (!detail) return res.status(404).json({ error: "MATERIAL_NOT_FOUND", message: "资料不存在或无权访问" });
    res.json({ material: detail });
  } catch (error) { next(error); }
});

app.get("/api/me/courses", requireAuth, (req, res) => {
  res.json({ courses: listUserCourses(req.user.id) });
});

// 列出某个课程已下载到本地的文件（需课程访问权限）
app.get("/api/courses/:courseId/files", requireAuth, async (req, res, next) => {
  try {
    const { courseId } = req.params;
    const user = currentUser(req);
    const data = readData();
    if (!data.courses.some(course => course.id === courseId)) {
      return res.status(404).json({ error: "COURSE_NOT_FOUND", message: "课程不存在" });
    }
    if (!canViewCourse(user, courseId)) return res.status(403).json({ error: "ACCESS_DENIED", message: "请先加入该课程" });
    let names = [];
    try { names = await fs.readdir(path.join(uploadDir, String(courseId))); } catch (_) { names = []; }
    res.json({ courseId, files: names });
  } catch (err) {
    next(err);
  }
});

// 下载 uploads/<courseId>/ 下已采集的文件（校验课程权限 + 防路径穿越）
app.get("/api/courses/:courseId/files/:fileName", requireAuth, async (req, res, next) => {
  try {
    const { courseId } = req.params;
    const requested = String(req.params.fileName);
    const safeName = sanitizeFileName(requested);
    if (safeName !== requested) return res.status(400).json({ error: "INVALID_PATH", message: "非法路径" });
    const user = currentUser(req);
    const data = readData();
    if (!data.courses.some(course => course.id === courseId)) {
      return res.status(404).json({ error: "COURSE_NOT_FOUND", message: "课程不存在" });
    }
    if (!canViewCourse(user, courseId)) return res.status(403).json({ error: "ACCESS_DENIED", message: "请先加入该课程" });
    const courseDir = path.resolve(uploadDir, String(courseId));
    const filePath = path.resolve(courseDir, safeName);
    if (!filePath.startsWith(courseDir + path.sep)) {
      return res.status(400).json({ error: "INVALID_PATH", message: "非法路径" });
    }
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return res.status(404).json({ error: "FILE_NOT_FOUND", message: "本地文件不存在" });
    res.download(filePath, safeName);
  } catch (err) {
    if (err.code === "ENOENT") {
      res.status(404).json({ error: "FILE_NOT_FOUND", message: "本地文件不存在" });
    } else {
      next(err);
    }
  }
});

// 按资料 id 下载附件：从数据库取 file_path，鉴权后下发（上传/同步统一入口）
app.get("/api/materials/:materialId/file", requireAuth, async (req, res, next) => {
  try {
    const user = currentUser(req);
    const data = readData();
    const found = findMaterialById(data, req.params.materialId);
    if (!found) return res.status(404).json({ error: "MATERIAL_NOT_FOUND", message: "资料不存在" });
    if (!canViewCourse(user, found.course.id)) return res.status(403).json({ error: "ACCESS_DENIED", message: "无权访问该资料" });
    const filePath = resolveUploadPath(found.material.filePath);
    if (!filePath) return res.status(404).json({ error: "FILE_NOT_FOUND", message: "该资料没有本地文件" });
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat || !stat.isFile()) return res.status(404).json({ error: "FILE_NOT_FOUND", message: "本地文件不存在" });
    res.download(filePath, sanitizeFileName(found.material.fileName || path.basename(filePath)));
  } catch (err) {
    next(err);
  }
});

app.post("/api/courses/:courseId/join", requireAuth, requireRole("student"), (req, res) => {
  const membership = addCourseMember(req.params.courseId, req.user.id, "student");
  if (!membership) return res.status(404).json({ error: "COURSE_NOT_FOUND", message: "课程不存在" });
  res.status(201).json({ membership });
});

app.delete("/api/courses/:courseId/leave", requireAuth, requireRole("student"), (req, res) => {
  if (!removeCourseMember(req.params.courseId, req.user.id)) return res.status(404).json({ error: "MEMBERSHIP_NOT_FOUND", message: "尚未加入该课程" });
  res.status(204).end();
});

app.get("/api/courses/:courseId/members", requireAuth, requireRole("teacher", "admin"), (req, res) => {
  if (req.user.role === "teacher" && !getMembership(req.params.courseId, req.user.id)) {
    return res.status(403).json({ error: "COURSE_ACCESS_DENIED", message: "你不是该课程教师" });
  }
  res.json({ members: listCourseMembers(req.params.courseId) });
});

app.post("/api/courses/:courseId/members", requireAuth, requireRole("teacher", "admin"), (req, res) => {
  if (req.user.role === "teacher" && !getMembership(req.params.courseId, req.user.id)) {
    return res.status(403).json({ error: "COURSE_ACCESS_DENIED", message: "你不是该课程教师" });
  }
  const { userId, memberRole = "student" } = req.body || {};
  const membership = addCourseMember(req.params.courseId, userId, memberRole);
  if (!membership) return res.status(404).json({ error: "MEMBER_OR_COURSE_NOT_FOUND", message: "用户或课程不存在" });
  res.status(201).json({ membership });
});

app.delete("/api/courses/:courseId/members/:userId", requireAuth, requireRole("teacher", "admin"), (req, res) => {
  if (req.user.role === "teacher" && !getMembership(req.params.courseId, req.user.id)) {
    return res.status(403).json({ error: "COURSE_ACCESS_DENIED", message: "你不是该课程教师" });
  }
  if (!removeCourseMember(req.params.courseId, req.params.userId)) return res.status(404).json({ error: "MEMBERSHIP_NOT_FOUND", message: "成员不存在" });
  res.status(204).end();
});

app.put("/api/materials/:materialId/review", requireAuth, requireRole("teacher", "admin"), (req, res) => {
  const { status, note } = req.body || {};
  const material = reviewMaterial(req.params.materialId, req.user, status, note);
  if (!material) return res.status(404).json({ error: "MATERIAL_NOT_FOUND", message: "资料不存在或审核状态无效" });
  res.json({
    material: {
      id: material.id,
      reviewStatus: material.review_status,
      reviewedBy: material.reviewed_by,
      reviewedAt: material.reviewed_at,
      reviewNote: material.review_note
    }
  });
});

// 归档或恢复资料（管理员 / 教师）
app.put("/api/materials/:materialId/archive", requireAuth, requireRole("teacher", "admin"), (req, res) => {
  const material = setArchived(req.params.materialId, req.user, (req.body && req.body.archived) !== false);
  if (!material) return res.status(404).json({ error: "MATERIAL_NOT_FOUND", message: "资料不存在或无权操作" });
  res.json({ material: { id: material.id, status: material.status, statusText: material.status_text } });
});

// 物理删除资料（管理员 / 教师）
app.delete("/api/materials/:materialId", requireAuth, requireRole("teacher", "admin"), (req, res) => {
  const result = removeMaterial(req.params.materialId, req.user);
  if (!result) return res.status(404).json({ error: "MATERIAL_NOT_FOUND", message: "资料不存在或无权删除" });
  res.json({ deleted: true, id: result.id || req.params.materialId });
});

app.post("/api/materials", requireAuth, requireRole("teacher", "admin"), async (req, res, next) => {
  try {
    const { name, course: courseId, type, source } = req.body;
    if(!name || !courseId || !type || !source) return res.status(400).json({ error: "INVALID_MATERIAL", message: "name、course、type、source 均为必填项" });
    const data = readData();
    const course = data.courses.find(item => item.id === courseId);
    if(!course) return res.status(404).json({ error: "COURSE_NOT_FOUND", message: "课程不存在" });
    const previous = course.materials.find(item => item.name === name && item.type === type);
    const versionChainId = previous ? previous.versionChainId : crypto.randomUUID();
    archivePreviousVersions(course, versionChainId);
    const material = normalizeMaterial({ name, type, source, versionChainId });
    material.version = nextVersion(course.materials, name, type);
    course.materials.unshift(material);
    course.count += 1;
    course.updates = "刚刚更新";
    if(material.status === "official") course.official += 1;
    data.alerts.unshift({
      title: `${course.name} · ${material.name}已加入`,
      desc: `${material.source}来源资料已登记，${material.status === "official" ? "已标记为官方资料。" : "已标记为学生整理。"}`,
      time: "刚刚",
      course: course.name,
      unread: true
    });

    applyAuthority(data.courses);
    writeData(data);
    res.status(201).json({ course, material });
  } catch(error) { next(error); }
});

app.post("/api/materials/upload", requireAuth, requireRole("teacher", "admin"), upload.single("file"), async (req, res, next) => {
  let storedFilePath = null;
  try {
    const { name, course: courseId, type, source } = req.body;
    if(!name || !courseId || !type || !source || !req.file) {
      if(req.file) await fs.rm(req.file.path, { force: true });
      return res.status(400).json({ error: "INVALID_UPLOAD", message: "name、course、type、source 和 file 均为必填项" });
    }
    const data = readData();
    const course = data.courses.find(item => item.id === courseId);
    if(!course) {
      await fs.rm(req.file.path, { force: true });
      return res.status(404).json({ error: "COURSE_NOT_FOUND", message: "课程不存在" });
    }
    const fileHash = await sha256(req.file.path);
    const features = await extractDocumentFeatures(req.file.path, req.file.originalname);
    const duplicate = data.courses
      .flatMap(item => item.materials)
      .find(item => item.fileHash === fileHash);
    if(duplicate) {
      await fs.rm(req.file.path, { force: true });
      return res.json({ duplicate: true, material: duplicate, message: "文件内容与已有资料完全一致" });
    }
    const candidates = course.materials
      .filter(item => item.type === type && item.extractedText)
      .map(item => ({ item, score: similarityScore(features, item.extractedText) }))
      .sort((a, b) => b.score - a.score);
    const related = candidates[0]?.score >= 0.55 ? candidates[0] : null;
    const versionChainId = related?.item.versionChainId
      || course.materials.find(item => item.name === name && item.type === type)?.versionChainId
      || crypto.randomUUID();
    // 新版本入库：同一版本链上的旧资料转为历史归档
    archivePreviousVersions(course, versionChainId);
    // 落盘到 uploads/<courseId>/，与下载路由保持一致（下载按资料 id 从库中取路径）
    const courseUploadDir = path.join(uploadDir, String(courseId));
    await fs.mkdir(courseUploadDir, { recursive: true });
    const storedName = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${sanitizeFileName(req.file.originalname)}`;
    const storedPath = path.join(courseUploadDir, storedName);
    try {
      await fs.rename(req.file.path, storedPath);
    } catch (moveError) {
      await fs.copyFile(req.file.path, storedPath);
      await fs.rm(req.file.path, { force: true });
    }
    storedFilePath = storedPath;
    const material = normalizeMaterial({
      name, type, source, fileHash, fileName: req.file.originalname,
      fileSize: req.file.size, versionChainId, filePath: path.relative(__dirname, storedPath)
    });
    material.version = nextVersion(course.materials, name, type);
    material.extractedText = features;
    material.similarity = related ? Number(related.score.toFixed(3)) : null;
    material.versionReason = related
      ? `与 ${related.item.version} 内容相似度 ${(related.score * 100).toFixed(1)}%，归入同一版本链`
      : "未发现相似历史资料，创建新的版本链";
    course.materials.unshift(material);
    course.count += 1;
    course.updates = "刚刚更新";
    if(material.status === "official") course.official += 1;
    data.alerts.unshift({
      title: `${course.name} · ${material.name}已上传`,
      desc: `${material.source}来源，${material.version} 已加入版本链。SHA-256：${fileHash.slice(0, 12)}…`,
      time: "刚刚", course: course.name, unread: true
    });
    applyAuthority(data.courses);
    writeData(data);
    res.status(201).json({
      course,
      material: {
        ...material,
        extractedText: undefined
      },
      duplicate: false,
      analysis: {
        textCharacters: features.structure.characters,
        headings: features.structure.headings,
        similarity: material.similarity,
        versionReason: material.versionReason,
        authorityScore: material.authorityScore,
        authorityBreakdown: material.authorityBreakdown,
        isAuthoritative: material.isAuthoritative
      }
    });
  } catch(error) {
    if(req.file) await fs.rm(req.file.path, { force: true }).catch(() => {});
    if(storedFilePath) await fs.rm(storedFilePath, { force: true }).catch(() => {});
    next(error);
  }
});

/** 判重：检查采集的条目是否与库中已有资料重复（按名称+来源） */
function findExistingMaterial(course, name, source) {
  return course.materials.find(
    (m) => m.name === name && (m.source === source || m.source === "Canvas")
  );
}

/**
 * 同步任务 API（Stage 3：可靠异步同步）
 *
 * 设计决策：
 *   - 不在 HTTP 请求内执行完整同步（避免长时间阻塞单次请求）
 *   - POST 后立即返回 202 + jobId，任务进入后台队列执行
 *   - 前端通过 GET /api/sync-jobs/:id 轮询，或 GET /api/sync-jobs/:id/events 走 SSE
 *   - 状态机：pending → running → success / failed / cancelled
 *   - 失败自动重试（指数退避），超时强杀，防止僵尸任务
 */
function jobLog(jobId, level, message, extra = null) {
  appendSyncJobLog(jobId, level, message, extra || null);
  if (syncEngine) {
    syncEngine.emitProgress(jobId, { level, message, ...(extra || {}) });
  }
}
app.post('/api/courses/:courseId/sync', requireAuth, requireRole('teacher', 'admin'), async (req, res, next) => {
  try {
    const courseId = String(req.params.courseId);
    const job = createSyncJob({ courseId, scope: 'course', createdBy: req.user.id });
    syncEngine.enqueueSyncJob(job.id);
    res.status(202).json({ job });
  } catch (err) { next(err); }
});
app.post('/api/sync-jobs', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const scope = String((req.body && req.body.scope) || 'global');
    const job = createSyncJob({ courseId: null, scope, createdBy: req.user.id });
    syncEngine.enqueueSyncJob(job.id);
    res.status(202).json({ job });
  } catch (err) { next(err); }
});
app.get('/api/sync-jobs', requireAuth, async (req, res, next) => {
  try {
    const jobs = listSyncJobs({ user: req.user });
    res.json({ jobs });
  } catch (err) { next(err); }
});
app.get('/api/sync-jobs/:id', requireAuth, async (req, res, next) => {
  try {
    const job = getSyncJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'SYNC_JOB_NOT_FOUND', message: '同步任务不存在' });
    const access = requireSyncJobAccess(job, req.user);
    if (!access.ok) return res.status(access.status).json({ error: access.error, message: access.message });
    res.json({ job });
  } catch (err) { next(err); }
});
app.get('/api/sync-jobs/:id/logs', requireAuth, async (req, res, next) => {
  try {
    const job = getSyncJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'SYNC_JOB_NOT_FOUND', message: '同步任务不存在' });
    const access = requireSyncJobAccess(job, req.user);
    if (!access.ok) return res.status(access.status).json({ error: access.error, message: access.message });
    res.json({ logs: getSyncJobLogs(req.params.id, { after: Number(req.query.after || 0) }) });
  } catch (err) { next(err); }
});
app.get('/api/sync-jobs/:id/events', async (req, res, next) => {
  try {
    const job = getSyncJob(req.params.id);
    if (!job) return res.status(404).end();
    const access = requireSyncJobAccess(job, req.user);
    if (!access.ok) return res.status(access.status).json({ error: access.error, message: access.message });
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write('retry: 2000\n\n');
    res.write('data: ' + JSON.stringify({ job, logs: getSyncJobLogs(req.params.id).slice(-20) }) + '\n\n');
    const eventName = syncEngine.progressEvent(req.params.id);
    const listener = (payload) => res.write('data: ' + JSON.stringify(payload) + '\n\n');
    syncEngine.listen(eventName, listener);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(heartbeat); syncEngine.removeListener(eventName, listener); });
  } catch (err) { next(err); }
});

app.put("/api/alerts/read", requireAuth, async (req, res, next) => {
  try {
    const data = readData();
    data.alerts.forEach(alert => { alert.unread = false; });
    writeData(data);
    res.json({ updated: data.alerts.length });
  } catch(error) { next(error); }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "INTERNAL_ERROR", message: "服务暂时不可用" });
});

fs.mkdir(uploadDir, { recursive: true })
  .then(() => app.listen(port, () => {
    console.log(`Course Trace API running at http://localhost:${port}`);

    // 定时自动同步：每天 03:00 检查一次 Canvas 新资料（可配置）
    const AUTO_SYNC_INTERVAL_MS = Number(process.env.AUTO_SYNC_INTERVAL_MS || 24 * 60 * 60 * 1000);
    const shouldRunNow = () => {
      const h = new Date().getHours();
      // 每轮都检查；为避免反复立即执行，首轮等待一个完整周期
      return false;
    };
    const runAutoSync = async () => {
      if (canvas.hasToken() && !canvas.MODE_DEACTIVATED) {
        const courses = canvas.listCourses ? canvas.listCourses() : [];
        console.log(`[auto-sync] 扫描 ${courses.length} 门课的 Canvas 资料`);
        for (const course of courses) {
          try {
            const raw = await canvas.collectCourseFiles(course.id);
            const entries = Array.isArray(raw) ? raw : (raw.items || raw.entries || []);
            if (entries.length > 0) {
              console.log(`[auto-sync] 课程 ${course.name}: 采集到 ${entries.length} 份资料`);
            }
          } catch (e) {
            console.error(`[auto-sync] 课程 ${course.name} 同步失败:`, e.message);
          }
        }
      } else {
        console.log("[auto-sync] 未配置 Canvas token，跳过自动同步");
      }
    };
    // 首轮延迟一个周期(默认24h)再启动；便于服务稳定后再执行
    setInterval(runAutoSync, AUTO_SYNC_INTERVAL_MS);
    console.log(`[auto-sync] 定时同步已启用，周期 ${Math.round(AUTO_SYNC_INTERVAL_MS / 3600000)} 小时`);
  }))
  .catch(error => {
    console.error("Failed to initialize upload directory", error);
    process.exitCode = 1;
  });
