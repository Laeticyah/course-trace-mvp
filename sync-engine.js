/**
 * sync-engine.js — 课脉 · Canvas 同步引擎
 *
 * 职责：将完整的 Canvas 同步从 HTTP 请求上下文中剥离出来，作为后台任务执行。
 *
 * 关键特性（Stage 3 可靠性清单）：
 *   1. 任务状态机：pending → running → success / failed / cancelled
 *   2. 失败重试：指数退避（attempt 1 → 1s，attempt 2 → 2s，attempt 3 → 4s，上限 30s）
 *   3. 超时强杀：单次同步超过 SYNC_TIMEOUT_MS 强制失败，防止僵尸任务
 *   4. 增量同步：跳过本地已存在的文件，仅处理变更
 *   5. 职责单一：本模块不参与 HTTP、不持有启动器逻辑。只提供「启动一个后台任务」的纯执行入口。
 */

const crypto = require("node:crypto");
const path = require("node:path");
const canvas = require("./canvas");
const dbModule = require("./database");
const { normalizeMaterial } = require("./lib/material");
const { applyAuthority } = require("./lib/authority");
const { getSyncJob, updateSyncJob, appendSyncJobLog } = dbModule;

// ---- 运行时默认值（可被环境变量覆盖） ----
const SYNC_TIMEOUT_MS = Number(process.env.SYNC_TIMEOUT_MS || 5 * 60 * 1000);
const MAX_ATTEMPTS = Number(process.env.SYNC_MAX_ATTEMPTS || 3);
const RETRY_BASE_DELAY_MS = Number(process.env.SYNC_RETRY_BASE_MS || 1000);
const RETRY_MAX_DELAY_MS = Number(process.env.SYNC_RETRY_MAX_MS || 30 * 1000);

/**
 * 事件总线：供 SSE 订阅 / 轮询逻辑监听“任务进度”。
 * key = jobId；listener = (payload) => void
 */
const listeners = new Map();

function progressEvent(jobId) {
  return `sync:${jobId}`;
}

function emitProgress(jobId, payload) {
  const key = progressEvent(jobId);
  if (listeners.has(key)) {
    for (const l of listeners.get(key)) {
      try {
        l(payload);
      } catch (e) {
        // 监听器异常不应影响同步主流程
      }
    }
  }
}

function onProgress(jobId, listener) {
  const key = progressEvent(jobId);
  if (!listeners.has(key)) {
    listeners.set(key, new Set());
  }
  listeners.get(key).add(listener);
  return () => {
    const set = listeners.get(key);
    if (set) {
      set.delete(listener);
      if (set.size === 0) {
        listeners.delete(key);
      }
    }
  };
}

/** 工具：延迟 n 毫秒 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 工具：给异步操作加超时（超时抛 SYNC_TIMEOUT，不阻塞队列） */
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(message || "操作超时"), { code: "SYNC_TIMEOUT" })), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 核心同步流程。阻塞式执行一次全部同步逻辑。
 * @param {string} jobId
 */
async function executeSyncJob(jobId) {
  const job = dbModule.getSyncJob(jobId);
  if (!job) {
    throw new Error("JOB_NOT_FOUND:" + jobId);
  }
  // 全局同步尚未实现：避免把 null 当 courseId 生成一条“null 课程”的脏数据
  if (!job.courseId) {
    updateSyncJob(jobId, { status: "failed", error: "全局同步暂未实现，请按课程触发同步", currentStep: "failed" });
    appendSyncJobLog(jobId, "error", "全局同步暂未实现，请按课程触发同步");
    emitProgress(jobId, { job: dbModule.getSyncJob(jobId), event: "failed" });
    return;
  }

  appendSyncJobLog(jobId, "info", "任务进入执行队列");

  // 1) 采集阶段
  updateSyncJob(jobId, { status: "running" });
  emitProgress(jobId, { job, status: "running" });

  const startedAt = Date.now();
  try {
    const deadline = startedAt + SYNC_TIMEOUT_MS;

    // 1.1) 采集（带超时与有限重试）
    appendSyncJobLog(jobId, "info", "正在从 Canvas 抓取课程数据…");
    const courseId = job.courseId;

    let collected;
    let lastCollectError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        updateSyncJob(jobId, { attempts: attempt });
        const raw = await withTimeout(canvas.collectCourseFiles(courseId), SYNC_TIMEOUT_MS, "Canvas 采集超时");
        const collection = normalizeCollection(raw, courseId);
        const mode = raw && raw.mode ? raw.mode : "unknown";
        const diagnostics = (raw && raw.diagnostics) || [];
        if (diagnostics.length) {
          appendSyncJobLog(jobId, "warn", "Canvas 采集提示：" + diagnostics.slice(0, 3).join("；"));
        }
        if (!collection.length) {
          throw Object.assign(new Error("CANVAS_EMPTY_COLLECTION"), { code: "EMPTY_COLLECTION" });
        }
        collected = collection;
        appendSyncJobLog(jobId, "info", "Canvas 采集完成（" + mode + "），共 " + collected.length + " 条记录");
        break;
      } catch (collectErr) {
        lastCollectError = collectErr;
        appendSyncJobLog(jobId, "warn", "采集失败（第 " + attempt + "/" + MAX_ATTEMPTS + " 次）：" + (collectErr.message || collectErr));
        // 空结果/非 Canvas 课程属于确定性失败，不再重试
        if (collectErr.code === "EMPTY_COLLECTION") break;
        if (attempt < MAX_ATTEMPTS) {
          await sleep(Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1)));
        }
      }
    }
    if (!collected || collected.length === 0) {
      throw lastCollectError || new Error("CANVAS_EMPTY_COLLECTION");
    }

    // 1.2) 下载（增量）
    const downloaded = await downloadIncremental(courseId, collected, jobId);
    appendSyncJobLog(jobId, "info", "文件下载完成：" + downloaded + " 份新文件");

    // 1.3) 判重 → 版本识别 → 入库
    const added = [];
    const updated = [];
    const skipped = [];

    const data = dbModule.readData();
    let course = data.courses.find((c) => String(c.id) === String(courseId));
    const createdCourse = !course;
    if (!course) {
      // 真实 Canvas 课程：先取课程名/代码，避免用数字 id 当课程名
      let info = null;
      try { info = await canvas.getCourseInfo(courseId); } catch (_) { info = null; }
      course = {
        id: String(courseId),
        code: (info && info.course && info.course.code) || String(courseId),
        name: (info && info.course && info.course.name) || String(courseId),
        desc: (info && info.course && info.course.desc) || "从 Canvas 同步创建",
        color: "blue",
        count: 0,
        progress: 0,
        official: 0,
        updates: "刚刚创建",
        materials: [],
      };
      data.courses.push(course);
    }

    for (const entry of collected) {
      const existing = findExistingMaterial(course, entry.name, entry.source);
      const versionChanged = Boolean(existing) && String(existing.version) !== String(entry.version || "V1.0");

      // 同版本：只补全缺失的文件信息，不新建版本
      if (existing && !versionChanged) {
        if (!existing.filePath && entry.filePath) {
          existing.filePath = entry.filePath;
          existing.fileHash = entry.fileHash || existing.fileHash;
          existing.fileSize = entry.fileSize ?? existing.fileSize;
          existing.fileName = existing.fileName || entry.name;
          updated.push(entry.name);
          appendSyncJobLog(jobId, "info", "补全文件路径：" + entry.name);
        } else {
          skipped.push(entry.name);
        }
        continue;
      }

      // 新资料 / 版本升级：升级时把旧版本标记归档，新版本进入同一版本链
      const chainId = existing ? existing.versionChainId : crypto.randomUUID();
      if (versionChanged) {
        for (const item of course.materials) {
          if (item.versionChainId === chainId && item.status !== "archived") {
            item.status = "archived";
            item.statusText = "已归档";
            item.isAuthoritative = false;
          }
        }
      }

      const material = normalizeMaterial({
        name: entry.name,
        type: entry.type || "课件",
        source: entry.source || "Canvas",
        version: entry.version || "V1.0",
        date: entry.date || undefined,
        fileHash: entry.fileHash || null,
        fileName: entry.fileName || entry.name || null,
        fileSize: entry.fileSize ?? null,
        filePath: entry.filePath || null,
        versionChainId: chainId,
      });
      if (entry.text) {
        material.extractedText = {
          text: entry.text,
          structure: {
            headings: 0,
            characters: entry.text.length,
            words: entry.text.split(/\s+/).length,
          },
        };
      }
      course.materials.unshift(material);
      course.count += 1;
      if (material.status === "official") course.official += 1;
      if (versionChanged) {
        updated.push(material.name);
        appendSyncJobLog(jobId, "info", "版本升级：" + material.name + " → " + material.version);
      } else {
        added.push(material.name);
        appendSyncJobLog(jobId, "info", "新增资料：" + material.name + " (" + material.version + ")");
      }
    }

    course.updates = "刚刚更新";
    // 统一权威重算
    applyAuthority(data.courses);

    if (added.length + updated.length > 0) {
      data.alerts.unshift({
        title: "已从 Canvas 同步 " + course.name,
        desc: "新增 " + added.length + " 份资料" + (updated.length ? "，更新 " + updated.length + " 份" : "") + (skipped.length ? "，跳过 " + skipped.length + " 份" : ""),
        time: "刚刚",
        course: course.name,
        unread: true,
      });
      dbModule.writeData(data);
      // 由同步任务首次创建的 Canvas 课程，把触发者登记为课程教师
      if (createdCourse && job.createdBy) {
        try { dbModule.addCourseMember(course.id, job.createdBy, "teacher"); } catch (_) { /* ignore */ }
      }
    }

    if (Date.now() > deadline) {
      throw Object.assign(new Error("SYNC_TIMEOUT"), { code: "SYNC_TIMEOUT" });
    }

    updateSyncJob(jobId, {
      status: "success",
      progress: 100,
      currentStep: "done",
      result: { added: added.length, updated: updated.length, skipped: skipped.length, total: collected.length },
    });
    appendSyncJobLog(jobId, "success", "同步成功");
    emitProgress(jobId, { job: dbModule.getSyncJob(jobId), event: "done" });
  } catch (err) {
    const timeoutMsg = formatSyncError(err);
    updateSyncJob(jobId, {
      status: "failed",
      error: timeoutMsg,
      currentStep: "failed",
    });
    appendSyncJobLog(jobId, "error", "任务失败: " + timeoutMsg);
    emitProgress(jobId, { job: dbModule.getSyncJob(jobId), event: "failed", error: timeoutMsg });
  }
}

/** 把底层错误转成可读的失败原因（前端 toast / 任务日志直接展示） */
function formatSyncError(error) {
  const message = String((error && error.message) || error || "同步异常");
  if (error && error.code === "SYNC_TIMEOUT") return "操作超时";
  if (message.includes("TOKEN_UNAUTHORIZED")) return "Canvas Token 无效，或没有该课程的访问权限";
  if (message.includes("CANVAS_HTTP_404")) return "Canvas 上找不到该课程（种子课程不是 Canvas 课程，请选择 Canvas 同步课程）";
  if (message.includes("CANVAS_HTTP_")) return "Canvas 接口返回异常：" + message;
  if (message.includes("CANVAS_EMPTY_COLLECTION")) return "Canvas 上没有采集到资料（该课程可能不是 Canvas 课程，或课程资料为空）";
  if (message.includes("NO_VALID_TOKEN")) return "未配置有效的 Canvas Token";
  return message;
}

function normalizeCollection(raw, courseId) {
  const arr = Array.isArray(raw) ? raw : (raw.items || raw.entries || []);
  return arr.map((it) => ({
    name: it.display_name || it.name || it.title || "未命名资料",
    type: it.type || "课件",
    source: it.source || "Canvas",
    version: it.version || "V1.0",
    date: it.date || it.modified_at || it.created_at || it.updated_at || "",
    fileSize: it.size ?? it.fileSize ?? null,
    fileName: it.fileName || it.display_name || it.name || null,
    mime: it.mime || it["content-type"] || null,
    // Canvas 原始字段叫 fileUrl（canvas.js 的 toMaterialEntry），兼容旧字段 url
    url: it.fileUrl || it.url || null,
    text: it.text || "",
  }));
}

/** 下载 Canvas 文件到 uploads/<courseId>/（增量：已存在非空文件则跳过） */
async function downloadIncremental(courseId, entries, jobId) {
  const fsP = require("node:fs/promises");
  const uploadRoot = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(__dirname, "uploads");
  const dir = path.join(uploadRoot, String(courseId));
  await fsP.mkdir(dir, { recursive: true });

  let count = 0;
  for (const entry of entries) {
    if (!entry.url) continue;
    const filename = (entry.fileName || entry.name || "file").replace(/[\\/:*?"<>|]/g, "_");
    const localPath = path.join(dir, filename);
    try {
      const stat = await fsP.stat(localPath);
      if (stat.size > 0) continue;
    } catch (_) { /* 文件不存在则下载 */ }
    try {
      const resp = await fetch(entry.url, { headers: canvas.getAuthHeaders() });
      if (resp.ok) {
        const buf = Buffer.from(await resp.arrayBuffer());
        await fsP.writeFile(localPath, buf);
        entry.filePath = path.relative(__dirname, localPath);
        entry.fileHash = crypto.createHash("sha256").update(buf).digest("hex");
        entry.fileSize = buf.length;
        count++;
      } else {
        appendSyncJobLog(jobId, "warn", "文件下载失败（HTTP " + resp.status + "）：" + filename);
      }
    } catch (error) {
      appendSyncJobLog(jobId, "warn", "文件下载失败：" + filename + "，" + (error.message || error));
    }
  }
  return count;
}

function findExistingMaterial(course, name, source) {
  return (course.materials || []).find((m) => m.name === name && (m.source === source || m.source === "Canvas"));
}

/**
 * 把任务放入队列并启动后台执行。
 * 幂等：同一 job 已在 running 时不重复入队。
 */
const enqueued = new Set();

function enqueueSyncJob(jobId) {
  const job = getSyncJob(jobId);
  if (!job) {
    throw new Error("JOB_NOT_FOUND:" + jobId);
  }
  if (enqueued.has(jobId)) return job;
  enqueued.add(jobId);

  setImmediate(() => {
    executeSyncJob(jobId)
      .catch((err) => {
        updateSyncJob(jobId, { status: "failed", error: err.message || "UNKNOWN_ERROR", currentStep: "failed" });
      })
      .finally(() => {
        enqueued.delete(jobId);
      });
  });
  return job;
}

module.exports = {
  progressEvent,
  onProgress,
  emitProgress,
  enqueueSyncJob,
  executeSyncJob,
  normalizeCollection,
  downloadIncremental,
};
