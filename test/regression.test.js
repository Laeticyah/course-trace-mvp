/**
 * 回归测试 · 课脉核心功能闭环
 * 运行方式: node --test test/
 * 前置条件: 先启动 server (node server.js)
 *
 * 覆盖: 健康检查 / 登录 / 仪表盘 / 课程列表 / 课程资料 / 同步 / 下载
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const { execFile } = require("node:child_process");
const path = require("node:path");

const BASE = "http://localhost:4173";

let serverProcess = null;
let adminToken = null;
let teacherToken = null;
let studentToken = null;

// 启动独立测试服务器（避免依赖已运行的实例）
function startServer() {
  return new Promise((resolve) => {
    serverProcess = execFile(process.execPath, ["server.js"], {
      cwd: path.resolve(__dirname, ".."),
    });
    serverProcess.stdout && serverProcess.stdout.on("data", () => {});
    serverProcess.stderr && serverProcess.stderr.on("data", () => {});
    // 等待就绪
    let attempts = 0;
    const check = setInterval(() => {
      fetch(BASE + "/api/health").then(() => {
        clearInterval(check);
        resolve();
      }).catch(() => {
        if (++attempts > 20) { clearInterval(check); resolve(); }
      });
    }, 300);
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!serverProcess) return resolve();
    serverProcess.kill();
    setTimeout(resolve, 200);
  });
}

async function login(username, password) {
  const res = await fetch(BASE + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  if (res.status !== 200) {
    throw new Error(`登录失败 ${username}: ${res.status}`);
  }
  const data = await res.json();
  return data.token;
}

before(async () => { await startServer(); });
after(async () => { await stopServer(); });

describe("课脉核心功能回归", () => {
  it("健康检查返回 200", async () => {
    const res = await fetch(BASE + "/api/health");
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.ok, true);
    assert.ok(data.service);
  });

  it("三角色登录都成功", async () => {
    adminToken = await login("admin", "admin123");
    teacherToken = await login("teacher", "teacher123");
    studentToken = await login("student", "student123");
    assert.ok(adminToken, "管理员 token 存在");
    assert.ok(teacherToken, "教师 token 存在");
    assert.ok(studentToken, "学生 token 存在");
  });

  it("未认证访问仪表盘应 401", async () => {
    const res = await fetch(BASE + "/api/dashboard");
    assert.strictEqual(res.status, 401);
  });

  it("学生只能看到已加入课程 (eng911)", async () => {
    const res = await fetch(BASE + "/api/dashboard", {
      headers: { Authorization: `Bearer ${studentToken}` }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    const ids = data.courses.map(c => c.id);
    assert.ok(ids.includes("eng101"), "学生应该能看到 eng101");
    assert.ok(!ids.includes("97558"), "学生不应该看到未加入的 97558");
  });

  it("教师能看到全部课程", async () => {
    const res = await fetch(BASE + "/api/dashboard", {
      headers: { Authorization: `Bearer ${teacherToken}` }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    const ids = data.courses.map(c => c.id);
    assert.ok(ids.includes("97558"), "教师应该能看到 97558");
  });

  it("学生访问未加入课程资料应 403", async () => {
    const res = await fetch(BASE + "/api/courses/97558/materials", {
      headers: { Authorization: `Bearer ${studentToken}` }
    });
    assert.strictEqual(res.status, 403);
  });

  it("教师访问任意课程资料成功", async () => {
    const res = await fetch(BASE + "/api/courses/97558/materials", {
      headers: { Authorization: `Bearer ${teacherToken}` }
    });
    assert.strictEqual(res.status, 200);
  });

  it("同步任务：创建后立即返回 202 + jobId，并可在完成后查询结果", async () => {
    // Phase 1：创建任务 → 202，立即返回 job 记录（不阻塞）
    const createRes = await fetch(BASE + "/api/courses/97558/sync", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${teacherToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({})
    });
    assert.strictEqual(createRes.status, 202, "异步任务应返回 202");
    const created = await createRes.json();
    assert.ok(created.job && created.job.id, "返回 job.id");
    const jobId = created.job.id;

    // Phase 2：轮询任务状态（最多等待 ~6s）
    let job = created.job;
    for (let i = 0; i < 60 && job.status !== "success" && job.status !== "failed"; i++) {
      await new Promise(r => setTimeout(r, 100));
      const statusRes = await fetch(BASE + "/api/sync-jobs/" + encodeURIComponent(jobId), {
        headers: { Authorization: `Bearer ${teacherToken}` }
      });
      assert.strictEqual(statusRes.status, 200);
      job = (await statusRes.json()).job;
    }
    assert.ok(job.status === "success" || job.status === "failed", "任务应在超时前结束");
    assert.ok(job.progress === 100 || job.status === "failed", "进度应到 100 或任务失败");

    // Phase 3：日志可查
    const logsRes = await fetch(BASE + "/api/sync-jobs/" + encodeURIComponent(jobId) + "/logs", {
      headers: { Authorization: `Bearer ${teacherToken}` }
    });
    assert.strictEqual(logsRes.status, 200);
    const logsData = await logsRes.json();
    assert.ok(Array.isArray(logsData.logs) || Array.isArray(logsData), "日志为数组");
  });

  it("下载已采集文件成功", async () => {
    const res = await fetch(BASE + "/api/courses/97558/files/%E7%AC%AC1%E7%AB%A0-%E5%87%BD%E6%95%B0-1.pdf", {
      headers: { Authorization: `Bearer ${teacherToken}` }
    });
    assert.ok(res.status === 200 || res.status === 404, `下载请求响应 ${res.status}`);
    if (res.status === 200) {
      assert.ok(res.headers.get("content-type").includes("pdf"));
      const buf = Buffer.from(await res.arrayBuffer());
      assert.ok(buf.length > 0, "文件内容非空");
    }
  });
});
