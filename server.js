const express = require("express");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const dns = require("node:dns/promises");
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
  appendSyncJobLog, getSyncJobLogs, requireSyncJobAccess,
  recoverInterruptedSyncJobs
} = require("./database");
const syncEngine = require("./sync-engine");
const { normalizeMaterial } = require("./lib/material");
const { applyAuthority } = require("./lib/authority");
const sources = require("./lib/sources");

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

/* 静态资源白名单：只对外暴露前端页面与脚本，源码 / 数据库 / 上传文件不再走静态托管 */
const PUBLIC_FILES = new Set([
  "/", "/index.html", "/styles.css", "/app.js",
  "/enhancements.js", "/ux-polish.js"
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

/* --------------------- 资料导入（多渠道共用） --------------------- */

const REMOTE_MAX_BYTES = 25 * 1024 * 1024;
const REMOTE_ALLOWED_EXT = new Set([".pdf", ".ppt", ".pptx", ".doc", ".docx", ".txt", ".md", ".zip"]);

function requireKnownSource(source, res) {
  const normalized = sources.normalizeSource(source, null);
  if (!normalized) {
    res.status(400).json({ error: "INVALID_SOURCE", message: "不支持的资料来源，请使用 /api/sources 中的来源" });
    return null;
  }
  return normalized;
}

async function storeUploadedFile(courseId, tempPath, originalName) {
  const courseUploadDir = path.join(uploadDir, String(courseId));
  await fs.mkdir(courseUploadDir, { recursive: true });
  const storedName = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${sanitizeFileName(originalName)}`;
  const storedPath = path.join(courseUploadDir, storedName);
  try {
    await fs.rename(tempPath, storedPath);
  } catch (moveError) {
    await fs.copyFile(tempPath, storedPath);
    await fs.rm(tempPath, { force: true });
  }
  return storedPath;
}

/**
 * 把一个临时文件纳入课程资料库：SHA-256 判重 → 版本链识别 → 旧版归档 → 落盘 → 写库。
 * 上传、批量上传、链接导入、目录导入共用这一条链路。
 */
async function ingestMaterialFile({ data, course, name, type, source, tempPath, originalName }) {
  const fileHash = await sha256(tempPath);
  const features = await extractDocumentFeatures(tempPath, originalName);
  const duplicate = data.courses
    .flatMap((item) => item.materials)
    .find((item) => item.fileHash === fileHash);
  if (duplicate) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    return { duplicate: true, material: duplicate };
  }

  const candidates = course.materials
    .filter((item) => item.type === type && item.extractedText)
    .map((item) => ({ item, score: similarityScore(features, item.extractedText) }))
    .sort((a, b) => b.score - a.score);
  const related = candidates[0]?.score >= 0.55 ? candidates[0] : null;
  const versionChainId = related?.item.versionChainId
    || course.materials.find((item) => item.name === name && item.type === type)?.versionChainId
    || crypto.randomUUID();

  archivePreviousVersions(course, versionChainId);
  const storedPath = await storeUploadedFile(course.id, tempPath, originalName);
  try {
    const material = normalizeMaterial({
      name, type, source, fileHash,
      fileName: originalName,
      fileSize: (await fs.stat(storedPath)).size,
      versionChainId,
      filePath: path.relative(__dirname, storedPath)
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
    if (material.status === "official") course.official += 1;
    data.alerts.unshift({
      title: `${course.name} · ${material.name}已导入`,
      desc: `${material.source}来源，${material.version} 已加入版本链。SHA-256：${fileHash.slice(0, 12)}…`,
      time: "刚刚", course: course.name, unread: true
    });
    applyAuthority(data.courses);
    writeData(data);
    return { duplicate: false, material, features };
  } catch (error) {
    await fs.rm(storedPath, { force: true }).catch(() => {});
    throw error;
  }
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const parts = address.split(".").map(Number);
    return parts[0] === 0 || parts[0] === 10 || parts[0] === 127
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168);
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    return lower === "::1" || lower === "::" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80");
  }
  return true;
}

/** 链接导入的安全校验：只允许 http(s)，默认禁止内网/本机地址与重定向绕过 */
async function assertRemoteUrlAllowed(rawUrl) {
  let url;
  try { url = new URL(String(rawUrl)); } catch (_) { throw Object.assign(new Error("INVALID_URL"), { status: 400 }); }
  if (!["http:", "https:"].includes(url.protocol)) throw Object.assign(new Error("INVALID_URL"), { status: 400 });

  const allowHosts = String(process.env.IMPORT_ALLOW_PRIVATE_HOSTS || "")
    .split(",").map((item) => item.trim()).filter(Boolean);
  const host = url.hostname;
  if (allowHosts.includes(host) || allowHosts.includes(`${host}:${url.port || ""}`)) return url;
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw Object.assign(new Error("PRIVATE_ADDRESS_BLOCKED"), { status: 400 });
  }
  let addresses;
  try {
    addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  } catch (_) {
    throw Object.assign(new Error("DNS_LOOKUP_FAILED"), { status: 400 });
  }
  if (!addresses.length) throw Object.assign(new Error("DNS_LOOKUP_FAILED"), { status: 400 });
  if (addresses.some((item) => isPrivateAddress(item.address))) {
    throw Object.assign(new Error("PRIVATE_ADDRESS_BLOCKED"), { status: 400 });
  }
  return url;
}

async function downloadRemoteFile(rawUrl) {
  let current = String(rawUrl);
  for (let hop = 0; hop < 4; hop++) {
    const url = await assertRemoteUrlAllowed(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    let response;
    try {
      response = await fetch(url, { redirect: "manual", signal: controller.signal });
    } catch (_) {
      throw Object.assign(new Error("REMOTE_FETCH_FAILED"), { status: 400 });
    } finally {
      clearTimeout(timer);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw Object.assign(new Error("REMOTE_REDIRECT_INVALID"), { status: 400 });
      current = new URL(location, url).toString();
      continue;
    }
    if (!response.ok) throw Object.assign(new Error("REMOTE_HTTP_" + response.status), { status: 400 });
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > REMOTE_MAX_BYTES) throw Object.assign(new Error("REMOTE_FILE_TOO_LARGE"), { status: 400 });
    if (!response.body) throw Object.assign(new Error("REMOTE_EMPTY_BODY"), { status: 400 });
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > REMOTE_MAX_BYTES) {
        try { await reader.cancel(); } catch (_) { /* ignore */ }
        throw Object.assign(new Error("REMOTE_FILE_TOO_LARGE"), { status: 400 });
      }
      chunks.push(Buffer.from(value));
    }
    if (!total) throw Object.assign(new Error("REMOTE_EMPTY_BODY"), { status: 400 });
    return { buffer: Buffer.concat(chunks), contentType: response.headers.get("content-type") || "" };
  }
  throw Object.assign(new Error("TOO_MANY_REDIRECTS"), { status: 400 });
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
  try {
    if(extension === ".pdf"){
      const parsed = await pdfParse(await fs.readFile(filePath));
      text = parsed.text;
    } else if(extension === ".docx" || extension === ".pptx"){
      text = await extractOfficeText(filePath, extension);
    } else if(extension === ".txt" || extension === ".md"){
      text = await fs.readFile(filePath, "utf8");
    }
  } catch (error) {
    // 附件损坏或格式不标准时不让整次导入失败：按“无文本”入库，仍可用文件名/哈希治理
    console.warn("[extract] 文档解析失败，按无文本处理:", extension, error.message);
    text = "";
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

/* 写操作权限：管理员可操作任意课程；教师只能操作自己担任教师的课程 */
function isCourseTeacher(user, courseId) {
  if (!user) return false;
  if (user.role === "admin") return true;
  if (user.role !== "teacher") return false;
  const membership = getMembership(courseId, user.id);
  return Boolean(membership && membership.member_role === "teacher");
}

function ensureCourseTeacher(user, courseId, res) {
  if (isCourseTeacher(user, courseId)) return true;
  res.status(403).json({ error: "COURSE_ACCESS_DENIED", message: "你不是该课程的教师，无权执行此操作" });
  return false;
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
    const source = String(req.query.source || "").trim() || undefined;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);

    const user = currentUser(req);
    const data = readData();

    // 构建权限过滤：学生只能看已加入的课程；教师/管理员可看全部
    let allowedCourseIds = null;
    if (user?.role === "student") {
      allowedCourseIds = listUserCourses(user.id).map(c => c.id);
    }

    const results = searchMaterials({ q, courseId, type, source, user, limit });

    // 额外按课程权限过滤（学生无法访问未加入课程的搜索结果）
    let filtered = results;
    if (allowedCourseIds) {
      filtered = results.filter(r => allowedCourseIds.includes(r.courseId));
    }

    res.json({
      query: { q, courseId, type, source, limit },
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
  if (!ensureCourseTeacher(req.user, req.params.courseId, res)) return;
  res.json({ members: listCourseMembers(req.params.courseId) });
});

app.post("/api/courses/:courseId/members", requireAuth, requireRole("teacher", "admin"), (req, res) => {
  if (!ensureCourseTeacher(req.user, req.params.courseId, res)) return;
  const { userId, memberRole = "student" } = req.body || {};
  const membership = addCourseMember(req.params.courseId, userId, memberRole);
  if (!membership) return res.status(404).json({ error: "MEMBER_OR_COURSE_NOT_FOUND", message: "用户或课程不存在" });
  res.status(201).json({ membership });
});

app.delete("/api/courses/:courseId/members/:userId", requireAuth, requireRole("teacher", "admin"), (req, res) => {
  if (!ensureCourseTeacher(req.user, req.params.courseId, res)) return;
  if (!removeCourseMember(req.params.courseId, req.params.userId)) return res.status(404).json({ error: "MEMBERSHIP_NOT_FOUND", message: "成员不存在" });
  res.status(204).end();
});

app.put("/api/materials/:materialId/review", requireAuth, requireRole("teacher", "admin"), (req, res) => {
  const data = readData();
  const found = findMaterialById(data, req.params.materialId);
  if (!found) return res.status(404).json({ error: "MATERIAL_NOT_FOUND", message: "资料不存在" });
  if (!ensureCourseTeacher(req.user, found.course.id, res)) return;
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

// 归档或恢复资料（管理员 / 课程教师）
app.put("/api/materials/:materialId/archive", requireAuth, requireRole("teacher", "admin"), (req, res) => {
  const data = readData();
  const found = findMaterialById(data, req.params.materialId);
  if (!found) return res.status(404).json({ error: "MATERIAL_NOT_FOUND", message: "资料不存在" });
  if (!ensureCourseTeacher(req.user, found.course.id, res)) return;
  const material = setArchived(req.params.materialId, req.user, (req.body && req.body.archived) !== false);
  if (!material) return res.status(404).json({ error: "MATERIAL_NOT_FOUND", message: "资料不存在或无权操作" });
  res.json({ material: { id: material.id, status: material.status, statusText: material.status_text } });
});

// 物理删除资料（管理员 / 课程教师）
app.delete("/api/materials/:materialId", requireAuth, requireRole("teacher", "admin"), (req, res) => {
  const data = readData();
  const found = findMaterialById(data, req.params.materialId);
  if (!found) return res.status(404).json({ error: "MATERIAL_NOT_FOUND", message: "资料不存在" });
  if (!ensureCourseTeacher(req.user, found.course.id, res)) return;
  const result = removeMaterial(req.params.materialId, req.user);
  if (!result) return res.status(404).json({ error: "MATERIAL_NOT_FOUND", message: "资料不存在或无权删除" });
  res.json({ deleted: true, id: result.id || req.params.materialId });
});

app.post("/api/materials", requireAuth, requireRole("teacher", "admin"), async (req, res, next) => {
  try {
    const { name, course: courseId, type, source } = req.body;
    if(!name || !courseId || !type || !source) return res.status(400).json({ error: "INVALID_MATERIAL", message: "name、course、type、source 均为必填项" });
    const normalizedSource = requireKnownSource(source, res);
    if(!normalizedSource) return;
    const data = readData();
    const course = data.courses.find(item => item.id === courseId);
    if(!course) return res.status(404).json({ error: "COURSE_NOT_FOUND", message: "课程不存在" });
    if(!ensureCourseTeacher(req.user, courseId, res)) return;
    const previous = course.materials.find(item => item.name === name && item.type === type);
    const versionChainId = previous ? previous.versionChainId : crypto.randomUUID();
    archivePreviousVersions(course, versionChainId);
    const material = normalizeMaterial({ name, type, source: normalizedSource, versionChainId });
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
  try {
    const { name, course: courseId, type, source } = req.body || {};
    if(!name || !courseId || !type || !source || !req.file) {
      if(req.file) await fs.rm(req.file.path, { force: true });
      return res.status(400).json({ error: "INVALID_UPLOAD", message: "name、course、type、source 和 file 均为必填项" });
    }
    const normalizedSource = requireKnownSource(source, res);
    if(!normalizedSource) { await fs.rm(req.file.path, { force: true }); return; }
    const data = readData();
    const course = data.courses.find(item => item.id === courseId);
    if(!course) {
      await fs.rm(req.file.path, { force: true });
      return res.status(404).json({ error: "COURSE_NOT_FOUND", message: "课程不存在" });
    }
    if(!ensureCourseTeacher(req.user, courseId, res)) {
      await fs.rm(req.file.path, { force: true });
      return;
    }
    const result = await ingestMaterialFile({
      data, course,
      name: String(name).trim(), type, source: normalizedSource,
      tempPath: req.file.path, originalName: req.file.originalname
    });
    if(result.duplicate) {
      return res.json({ duplicate: true, material: result.material, message: "文件内容与已有资料完全一致" });
    }
    res.status(201).json({
      course,
      material: { ...result.material, extractedText: undefined },
      duplicate: false,
      source: normalizedSource,
      analysis: {
        textCharacters: result.features.structure.characters,
        headings: result.features.structure.headings,
        similarity: result.material.similarity,
        versionReason: result.material.versionReason,
        authorityScore: result.material.authorityScore,
        authorityBreakdown: result.material.authorityBreakdown,
        isAuthoritative: result.material.isAuthoritative
      }
    });
  } catch(error) {
    if(req.file) await fs.rm(req.file.path, { force: true }).catch(() => {});
    next(error);
  }
});

/** 批量上传：一次选多个文件（班级群/网盘下载的一批课件） */
app.post("/api/materials/upload-batch", requireAuth, requireRole("teacher", "admin"), upload.array("files", 20), async (req, res, next) => {
  try {
    const { name, course: courseId, type, source } = req.body || {};
    const files = req.files || [];
    if(!courseId || !type || !source || files.length === 0) {
      for(const file of files) await fs.rm(file.path, { force: true }).catch(() => {});
      return res.status(400).json({ error: "INVALID_UPLOAD", message: "course、type、source 和 files 均为必填项" });
    }
    const normalizedSource = requireKnownSource(source, res);
    if(!normalizedSource) {
      for(const file of files) await fs.rm(file.path, { force: true }).catch(() => {});
      return;
    }
    const data = readData();
    const course = data.courses.find(item => item.id === courseId);
    if(!course) {
      for(const file of files) await fs.rm(file.path, { force: true }).catch(() => {});
      return res.status(404).json({ error: "COURSE_NOT_FOUND", message: "课程不存在" });
    }
    if(!ensureCourseTeacher(req.user, courseId, res)) {
      for(const file of files) await fs.rm(file.path, { force: true }).catch(() => {});
      return;
    }
    const results = [];
    for(const file of files) {
      const baseName = path.parse(file.originalname).name;
      const materialName = files.length === 1 && name
        ? String(name).trim()
        : (name ? String(name).trim() + " - " + baseName : baseName);
      try {
        const result = await ingestMaterialFile({
          data, course,
          name: materialName || baseName || "未命名资料",
          type, source: normalizedSource,
          tempPath: file.path, originalName: file.originalname
        });
        results.push(result.duplicate
          ? { duplicate: true, fileName: file.originalname, materialId: result.material.id }
          : { duplicate: false, fileName: file.originalname, materialId: result.material.id, version: result.material.version });
      } catch (error) {
        await fs.rm(file.path, { force: true }).catch(() => {});
        results.push({ fileName: file.originalname, error: error.message || "导入失败" });
      }
    }
    res.status(201).json({ results, source: normalizedSource });
  } catch(error) {
    if(Array.isArray(req.files)) {
      for(const file of req.files) await fs.rm(file.path, { force: true }).catch(() => {});
    }
    next(error);
  }
});

/** 链接导入：网盘/班级群分享直链 → 下载 → 判重 → 版本链（带 SSRF 防护） */
app.post("/api/import/url", requireAuth, requireRole("teacher", "admin"), async (req, res, next) => {
  let tempPath = null;
  try {
    const { course: courseId, url, name, type = "课件", source = "网盘" } = req.body || {};
    if(!courseId || !url) {
      return res.status(400).json({ error: "INVALID_IMPORT", message: "course 和 url 均为必填项" });
    }
    const normalizedSource = requireKnownSource(source, res);
    if(!normalizedSource) return;
    const data = readData();
    const course = data.courses.find(item => item.id === courseId);
    if(!course) return res.status(404).json({ error: "COURSE_NOT_FOUND", message: "课程不存在" });
    if(!ensureCourseTeacher(req.user, courseId, res)) return;

    let parsedUrl;
    try { parsedUrl = new URL(String(url)); } catch (_) {
      return res.status(400).json({ error: "INVALID_URL", message: "链接格式不正确" });
    }
    const guessedName = String(name || "").trim()
      || decodeURIComponent((parsedUrl.pathname.split("/").pop() || ""))
      || "链接资料";
    const extension = path.extname(guessedName).toLowerCase();
    if(!REMOTE_ALLOWED_EXT.has(extension)) {
      return res.status(400).json({ error: "UNSUPPORTED_FILE_TYPE", message: "链接文件类型不支持：" + (extension || "未知") });
    }

    const remote = await downloadRemoteFile(url);
    tempPath = path.join(os.tmpdir(), "ct-import-" + crypto.randomUUID() + extension);
    await fs.writeFile(tempPath, remote.buffer);
    const result = await ingestMaterialFile({
      data, course,
      name: path.basename(guessedName, path.extname(guessedName)) || "链接资料",
      type, source: normalizedSource,
      tempPath, originalName: sanitizeFileName(guessedName)
    });
    if(result.duplicate) {
      return res.json({ duplicate: true, material: result.material, message: "链接文件与已有资料完全一致" });
    }
    res.status(201).json({
      course,
      material: { ...result.material, extractedText: undefined },
      duplicate: false,
      source: normalizedSource,
      analysis: {
        textCharacters: result.features.structure.characters,
        headings: result.features.structure.headings,
        similarity: result.material.similarity,
        versionReason: result.material.versionReason,
        authorityScore: result.material.authorityScore,
        authorityBreakdown: result.material.authorityBreakdown,
        isAuthoritative: result.material.isAuthoritative
      }
    });
  } catch(error) {
    if(error.status) {
      const messages = {
        INVALID_URL: "链接格式不正确",
        PRIVATE_ADDRESS_BLOCKED: "该链接指向内网/本机地址，已拦截",
        DNS_LOOKUP_FAILED: "链接域名解析失败",
        REMOTE_FETCH_FAILED: "链接下载失败或超时",
        REMOTE_FILE_TOO_LARGE: "链接文件超过 25MB 限制",
        REMOTE_EMPTY_BODY: "链接文件为空",
        TOO_MANY_REDIRECTS: "链接重定向次数过多"
      };
      return res.status(error.status).json({ error: error.message, message: messages[error.message] || "链接导入失败：" + error.message });
    }
    next(error);
  } finally {
    if(tempPath) await fs.rm(tempPath, { force: true }).catch(() => {});
  }
});

/** 渠道注册表：前端来源下拉、筛选与可信度说明共用 */
app.get("/api/sources", requireAuth, (_req, res) => {
  res.json({ sources: sources.listChannels() });
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
    const data = readData();
    let exists = data.courses.some(course => course.id === courseId);
    // 管理员可以直接用 Canvas 数字课程 id 触发同步：先把真实课程记录建出来，再创建同步任务
    if (!exists) {
      if (req.user.role !== 'admin' || !/^\d+$/.test(courseId)) {
        return res.status(404).json({ error: 'COURSE_NOT_FOUND', message: '课程不存在（可从 Canvas 导入课程后同步）' });
      }
      let info = null;
      try { info = await canvas.getCourseInfo(courseId); } catch (_) { info = null; }
      data.courses.push({
        id: courseId,
        code: (info && info.course && info.course.code) || courseId,
        name: (info && info.course && info.course.name) || ('Canvas 课程 ' + courseId),
        desc: (info && info.course && info.course.desc) || '',
        color: 'blue', count: 0, official: 0, progress: 0, updates: '等待同步', materials: []
      });
      writeData(data);
      exists = true;
    } else if (!ensureCourseTeacher(req.user, courseId, res)) {
      return;
    }
    const job = createSyncJob({ courseId, scope: 'course', createdBy: req.user.id });
    syncEngine.enqueueSyncJob(job.id);
    res.status(202).json({ job });
  } catch (err) { next(err); }
});
// 管理员：列出 Canvas 上的真实课程
app.get('/api/canvas/courses', requireAuth, requireRole('admin'), async (_req, res, next) => {
  try {
    const listing = await canvas.listCourses();
    res.json(listing);
  } catch (err) { next(err); }
});
// 管理员：一键导入 Canvas 上尚未入库的真实课程（每个课程创建一个同步任务）
app.post('/api/canvas/import-courses', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const listing = await canvas.listCourses();
    const data = readData();
    const existing = new Set(data.courses.map(course => course.id));
    const newCourses = [];
    for (const course of listing.courses || []) {
      const id = String(course.id);
      if (existing.has(id)) continue;
      data.courses.push({
        id,
        code: course.code || id,
        name: course.name || ('Canvas 课程 ' + id),
        desc: course.desc || '',
        color: 'blue', count: 0, official: 0, progress: 0, updates: '等待同步', materials: []
      });
      existing.add(id);
      newCourses.push(id);
    }
    if (newCourses.length) writeData(data);
    const jobs = newCourses.map((id) => {
      const job = createSyncJob({ courseId: id, scope: 'course', createdBy: req.user.id });
      syncEngine.enqueueSyncJob(job.id);
      return job;
    });
    res.status(202).json({ imported: jobs.length, jobs });
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
app.get('/api/sync-jobs', requireAuth, requireRole('teacher', 'admin'), async (req, res, next) => {
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
app.get('/api/sync-jobs/:id/events', requireAuth, async (req, res, next) => {
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
    const unsubscribe = syncEngine.onProgress(req.params.id, (payload) => res.write('data: ' + JSON.stringify(payload) + '\n\n'));
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
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
  .then(() => {
    // 服务重启后，遗留的 pending/running 任务不会再被执行，统一标记为失败
    const recovered = recoverInterruptedSyncJobs();
    if (recovered > 0) console.log(`[sync] ${recovered} 个中断的同步任务已标记为失败`);
    app.listen(port, () => {
      console.log(`Course Trace API running at http://localhost:${port}`);

      const runAutoSync = async () => {
        if (!canvas.hasToken()) {
          console.log("[auto-sync] 未配置 Canvas token，跳过自动同步");
          return;
        }
        const listing = await canvas.listCourses();
        const courses = Array.isArray(listing) ? listing : ((listing && listing.courses) || []);
        console.log(`[auto-sync] 扫描 ${courses.length} 门课的 Canvas 资料`);
        for (const course of courses) {
          try {
            const raw = await canvas.collectCourseFiles(course.id);
            const entries = Array.isArray(raw) ? raw : ((raw && (raw.items || raw.entries)) || []);
            if (entries.length > 0) {
              console.log(`[auto-sync] 课程 ${course.name}: 采集到 ${entries.length} 份资料`);
            }
          } catch (error) {
            console.error(`[auto-sync] 课程 ${course.name} 同步失败:`, error.message);
          }
        }
      };
      const logAutoSyncError = (error) => console.error("[auto-sync] 执行失败:", error.message);

      const interval = Number(process.env.AUTO_SYNC_INTERVAL_MS || 24 * 60 * 60 * 1000);
      if (!Number.isFinite(interval) || interval <= 0) {
        console.log("[auto-sync] 已通过 AUTO_SYNC_INTERVAL_MS=0 关闭定时同步");
      } else if (interval >= 24 * 60 * 60 * 1000) {
        // 每天本地时间 03:00 执行一次；执行后重新排下一次
        const scheduleNext = () => {
          const now = new Date();
          const next = new Date(now);
          next.setHours(3, 0, 0, 0);
          if (next <= now) next.setDate(next.getDate() + 1);
          const timer = setTimeout(async () => {
            try { await runAutoSync(); } catch (error) { logAutoSyncError(error); }
            scheduleNext();
          }, next.getTime() - now.getTime());
          if (timer.unref) timer.unref();
        };
        scheduleNext();
        console.log("[auto-sync] 每天 03:00 自动同步已启用");
      } else {
        const timer = setInterval(() => { runAutoSync().catch(logAutoSyncError); }, interval);
        if (timer.unref) timer.unref();
        console.log(`[auto-sync] 定时同步已启用，周期 ${Math.round(interval / 1000)} 秒`);
      }
    });
  })
  .catch(error => {
    console.error("Failed to initialize upload directory", error);
    process.exitCode = 1;
  });
