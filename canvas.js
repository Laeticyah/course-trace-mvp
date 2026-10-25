/**
 * canvas.js — 课脉 · Canvas 采集模块
 *
 * 职责：
 *   1) 读取配置（.env）：CANVAS_BASE_URL / CANVAS_TOKEN / CANVAS_MODE
 *   2) 优先走真实 Canvas REST API（Access Token 有效时）
 *   3) 无令牌 / 令牌失效 / 请求异常时，自动降级为模拟采集（Mock），保证对外演示不断流
 *
 * 本模块对上层暴露三个接口：
 *   - listCourses(params?)   -> 返回课程列表（Mock 或真实）
 *   - collectCourseStream(courseId) -> 返回课程下可同步的资料条目（Mock 或真实）
 *   - getDiagnostics()      -> 返回当前模式/来源/异常信息，便于前端诊断
 *
 * 模式判定：
 *   配置 CANVAS_MODE:
 *     - "mock" 或未配置 token → 模拟模式
 *     - "real"（默认）→ 若 token 有效则真实调用，否则自动降级 mock 并暴露原因
 */

const fs = require("node:fs");
const path = require("node:path");

// ---- 轻量 .env 解析（不引入额外依赖，兼容 Node >= 18）----
function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  const env = {};
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  }
  return { ...env, ...process.env };
}

const env = loadEnv();

function cfg(name, fallback) {
  return env[name] || fallback;
}

const BASE_URL = cfg("CANVAS_BASE_URL", "https://oc.sjtu.edu.cn").replace(/\/+$/, "");
const TOKEN = cfg("CANVAS_TOKEN", "").trim();

/** 判断是否具备走真实 API 的条件（本系统只同步真实 Canvas 数据，不再提供 mock 模式） */
function hasToken() {
  return Boolean(TOKEN) && !/^(paste_|xxx|your_|yourtoken)/i.test(TOKEN);
}

/** 下载 Canvas 文件时需要携带的鉴权头（无有效 token 时为空对象） */
function getAuthHeaders() {
  return hasToken() ? { Authorization: `Bearer ${TOKEN}` } : {};
}

/** 格式化日期为 xxxx.xx.xx */
function formatDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "2026.01.01";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}

/** 按文件名/来源推断资料类型 */
function inferType(name, raw = {}) {
  const lower = String(name).toLowerCase();
  if (/第[一二三四五六七八九十0-9]+章|chapter|lecture|课件|pptx?|\.ppt/.test(lower)) return "课件";
  if (/作业|assignment|homework|hw|quiz|测试/i.test(lower)) return "作业要求";
  if (/考试|exam|midterm|final|试卷/i.test(lower)) return "考试资料";
  if (/笔记|note|summary|复习|错题/i.test(lower)) return "复习笔记";
  return "课件";
}

const typeToMime = (type) => ({
  课件: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  作业要求: "text/plain",
  考试资料: "application/pdf",
  复习笔记: "text/markdown",
}[type] || "application/octet-stream");

/**
 * 把 Canvas 的裸 JSON 对象 → 归一化为课脉资料条目
 * 兼容 files 与 modules 两种来源
 */
function toMaterialEntry(raw, courseId, defaultType = "课件") {
  const name =
    raw.display_name ||
    raw.name ||
    raw.title ||
    raw.filename ||
    "未命名资料";

  return {
    name,
    type: defaultType,
    source: "Canvas",
    version: "V1.0",
    date: formatDate(raw.modified_at || raw.created_at || raw.posted_at || raw.updated_at),
    status: "official",
    statusText: "最新权威版",
    icon: defaultType === "课件" ? "▤" : "▣",
    fileUrl: raw.url || null,
    fileName: raw.display_name || name,
    fileSize: raw.size || null,
    mime: raw["content-type"] || typeToMime(defaultType),
    canvasId: "canvas:" + String(raw.id || ""),
    courseId,
  };
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((item) => {
    const key = `${item.canvasId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 真实 API 请求（跟随分页）
 */
async function canvasFetch(urlPath) {
  if (!hasToken()) {
    throw new Error("NO_VALID_TOKEN");
  }
  let url = `${BASE_URL}${urlPath.startsWith("/") ? urlPath : "/" + urlPath}`;
  url += (url.includes("?") ? "&" : "?") + "per_page=100";

  const out = [];
  while (url) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/json"
      }
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error("TOKEN_UNAUTHORIZED");
    }
    if (!res.ok) {
      throw new Error(`CANVAS_HTTP_${res.status}`);
    }
    const body = await res.json();
    if (Array.isArray(body)) out.push(...body);

    const link = res.headers.get("link");
    const nextMatch = link ? /<([^>]+)>\s*;\s*rel="next"/.exec(link) : null;
    url = nextMatch ? nextMatch[1] : null;
  }
  return out;
}

/**
 * 真实采集：一门课程的 文件 + 模块 + 公告
 */
async function realCollectCourseFiles(courseId) {
  try {
    const [filesRes, modulesRes, announcementsRes] = await Promise.allSettled([
      canvasFetch(`/api/v1/courses/${courseId}/files`),
      canvasFetch(`/api/v1/courses/${courseId}/modules`),
      canvasFetch(`/api/v1/courses/${courseId}/announcements`)
    ]);

    const entries = [];
    const diagnostics = [];

    // 文件→资料
    if (filesRes.status === "fulfilled") {
      const files = Array.isArray(filesRes.value) ? filesRes.value : (filesRes.value.files || []);
      for (const f of files) {
        entries.push(toMaterialEntry({ ...f, id: f.id }, courseId, "课件"));
      }
    } else {
      diagnostics.push(`files: ${filesRes.reason?.message || filesRes.reason}`);
    }

    // 模块 → 资料（类型课件，名称=模块名）
    if (modulesRes.status === "fulfilled") {
      const mods = Array.isArray(modulesRes.value) ? modulesRes.value : (modulesRes.value.modules || []);
      for (const m of mods) {
        entries.push(toMaterialEntry({ ...m, name: m.name, type: "课件" }, courseId, "课件"));
      }
    } else {
      diagnostics.push(`modules: ${modulesRes.reason?.message || modulesRes.reason}`);
    }

    // 公告 → 资料（类型=通知）
    for (const a of Array.isArray(announcementsRes.value) ? announcementsRes.value : []) {
      entries.push(toMaterialEntry({ ...a, name: `公告：${a.title}`, type: "通知" }, courseId, "通知"));
    }

    return { entries: dedupe(entries), diagnostics };
  } catch (err) {
    throw err;
  }
}

/** 列出账号可访问的真实 Canvas 课程 */
async function listCourses() {
  if (!hasToken()) throw new Error("NO_VALID_TOKEN");
  const raw = await canvasFetch("/api/v1/courses");
  const courses = raw
    .filter((course) => course && (course.name || course.course_code))
    .map((course) => ({
      id: String(course.id),
      code: course.course_code || String(course.id),
      name: course.name || String(course.id),
      desc: course.course_code || "",
    }));
  return { mode: "real", courses };
}

/**
 * 对外统一入口：采集一门课程的资料流（只走真实 Canvas API）
 */
async function collectCourseFiles(courseId) {
  if (!hasToken()) throw new Error("NO_VALID_TOKEN");
  const result = await realCollectCourseFiles(courseId);
  return {
    mode: "real",
    items: result.entries,
    diagnostics: result.diagnostics,
    fallback: result.fallback || false,
  };
}

/** 获取课程详情（仅真实模式），用于"课程不存在时自动建课" */
async function getCourseInfo(courseId) {
  try {
    const url = `${BASE_URL}/api/v1/courses/${courseId}?include[]=total_students`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/json"
      }
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error("TOKEN_UNAUTHORIZED");
    }
    if (!res.ok) {
      throw new Error(`CANVAS_HTTP_${res.status}`);
    }
    const c = await res.json();
    if (!c || typeof c !== "object") return { found: false, course: null };
    return {
      found: true,
      course: {
        id: String(courseId),
        code: c.course_code || "",
        name: c.name || "未命名课程",
        desc: (c.syllabus_body || "").replace(/<[^>]+>/g, "").slice(0, 200),
      },
    };
  } catch (err) {
    return { found: false, course: null };
  }
}

/**
 * 下载渠道文件到本地 uploads/ 目录，返回可入库的资料元数据。
 * @param {string} courseId 课程 id
 * @param {string} destDir  落盘目录（如 uploads/97558）
 * @returns {Promise<Array<{localPath:string, fileName:string, fileSize?:number, hash?:string, url?:string}>>}
 */
async function downloadCourseFiles(courseId, destDir) {
  const fs = require("node:fs/promises");
  const path = require("node:path");

  if (!hasToken()) throw new Error("NO_VALID_TOKEN");
  await fs.mkdir(destDir, { recursive: true });

  const files = await canvasFetch(`/api/v1/courses/${courseId}/files`).catch(() => []);
  const results = [];
  for (const f of files) {
    const rawName = f.display_name || f.filename || `file-${f.id}`;
    const safeName = rawName.replace(/[\\/:*?"<>|]/g, "_");
    const localPath = path.join(destDir, safeName);
    // Canvas 的 url 字段通常已含 token；若未含 token，回退拼接 download_frd=1
    const url = f.url;
    try {
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
      if (!resp.ok) continue;
      const buf = Buffer.from(await resp.arrayBuffer());
      await fs.writeFile(localPath, buf);
      const hash = require("node:crypto").createHash("sha256").update(buf).digest("hex");
      results.push({
        localPath: path.relative(process.cwd(), localPath),
        fileName: rawName,
        fileSize: buf.length,
        hash,
        url,
      });
    } catch (e) {
      // 单个文件下载失败不影响整体
    }
  }
  return results;
}

module.exports = {
  downloadCourseFiles,
  collectCourseFiles,
  listCourses,
  getCourseInfo,
  realCollectCourseFiles,
  hasToken,
  getAuthHeaders,
  cfg,
  BASE_URL,
};
