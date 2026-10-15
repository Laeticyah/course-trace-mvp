const express = require("express");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const {
  readData, writeData, createSession, findUserByCredentials,
  findUserByToken, deleteSession, reviewMaterial, getMembership,
  listUserCourses, listCourseMembers, addCourseMember, removeCourseMember
} = require("./database");

const app = express();
const port = Number(process.env.PORT || 4173);
const execFileAsync = promisify(execFile);
const uploadDir = path.join(__dirname, "uploads");
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
  const sourceScore = sourceAuthority[material.source] ?? 0.35;
  const newest = Math.max(...chain.map(item => parseDate(item.date).getTime()), Date.now());
  const ageDays = Math.max(0, (newest - parseDate(material.date).getTime()) / 86400000);
  const freshnessScore = Math.exp(-ageDays / 30);
  const similarity = Number(material.similarity ?? 0);
  const changeScore = material.extractedText
    ? Math.min(1, Math.max(0.1, 1 - similarity))
    : 0.55;
  const score = sourceScore * 0.5 + freshnessScore * 0.3 + changeScore * 0.2;
  return {
    score: Number(score.toFixed(3)),
    source: Number(sourceScore.toFixed(3)),
    freshness: Number(freshnessScore.toFixed(3)),
    change: Number(changeScore.toFixed(3))
  };
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
      const approved = scored
        .filter(item => item.material.reviewStatus === "approved")
        .sort((a, b) => parseDate(b.material.date) - parseDate(a.material.date))[0];
      const authoritative = approved || scored.reduce((best, item) =>
        !best || item.breakdown.score > best.breakdown.score ? item : best, null);
      for(const { material, breakdown } of scored){
        material.authorityScore = breakdown.score;
        material.authorityBreakdown = breakdown;
        material.isAuthoritative = material.id === authoritative.material.id;
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
app.use(express.static(__dirname));

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
  return !user || user.role === "admin" || Boolean(getMembership(courseId, user.id));
}

app.get("/api/dashboard", async (_req, res, next) => {
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

app.get("/api/courses", async (req, res, next) => {
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

app.get("/api/courses/:courseId/materials", async (req, res, next) => {
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

app.get("/api/me/courses", requireAuth, (req, res) => {
  res.json({ courses: listUserCourses(req.user.id) });
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

app.post("/api/materials", requireAuth, requireRole("teacher", "admin"), async (req, res, next) => {
  try {
    const { name, course: courseId, type, source } = req.body;
    if(!name || !courseId || !type || !source) return res.status(400).json({ error: "INVALID_MATERIAL", message: "name、course、type、source 均为必填项" });
    const data = readData();
    const course = data.courses.find(item => item.id === courseId);
    if(!course) return res.status(404).json({ error: "COURSE_NOT_FOUND", message: "课程不存在" });
    const material = normalizeMaterial({ name, type, source });
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
    const material = normalizeMaterial({
      name, type, source, fileHash, fileName: req.file.originalname,
      fileSize: req.file.size, versionChainId
    });
    material.version = nextVersion(course.materials, name, type);
    material.filePath = path.relative(__dirname, req.file.path);
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
    next(error);
  }
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
  }))
  .catch(error => {
    console.error("Failed to initialize upload directory", error);
    process.exitCode = 1;
  });
