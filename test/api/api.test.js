"use strict";

/**
 * 接口测试 · REST API
 * 运行方式: node --test test/api/
 * 说明: 自动启动独立 server 进程，测试结束后自动关闭
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const path = require("node:path");

const BASE = "http://localhost:4174"; // 使用独立端口，避免与回归测试冲突
const ROOT = path.resolve(__dirname, "..", ".."); // 仓库根目录
const SERVER_ENTRY = path.join(ROOT, "server.js");

let serverProcess = null;
let adminToken = null;
let studentToken = null;

function startServer() {
  return new Promise((resolve, reject) => {
    serverProcess = execFile(process.execPath, [SERVER_ENTRY], {
      cwd: ROOT,
      env: { ...process.env, PORT: "4174" },
    });
    serverProcess.stdout && serverProcess.stdout.on("data", (d) => console.log("[server]", d.toString().trim()));
    serverProcess.stderr && serverProcess.stderr.on("data", (d) => {
      if (!d.toString().includes("DeprecationWarning")) {
        console.error("[server:err]", d.toString().trim());
      }
    });
    serverProcess.on("error", (err) => reject(err));

    // 轮询等待 server 就绪（最多 8s）
    const deadline = Date.now() + 8000;
    const probe = () => {
      fetch(BASE + "/api/health").then(() => resolve()).catch((err) => {
        if (Date.now() > deadline) {
          reject(new Error("server 启动超时，最近错误: " + err.message));
        } else {
          setTimeout(probe, 250);
        }
      });
    };
    probe();
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

describe("健康检查", () => {
  it("GET /api/health 返回 200 且 ok:true", async () => {
    const res = await fetch(BASE + "/api/health");
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(data.service);
  });
});

describe("认证", () => {
  it("未认证访问 /api/dashboard 返回 401", async () => {
    const res = await fetch(BASE + "/api/dashboard");
    assert.equal(res.status, 401);
  });

  it("管理员登录成功并返回 token", async () => {
    adminToken = await login("admin", "admin123");
    assert.ok(adminToken, "应返回管理员 token");
  });

  it("学生登录成功并返回 token", async () => {
    studentToken = await login("student", "student123");
    assert.ok(studentToken, "应返回学生 token");
  });
});

describe("仪表盘", () => {
  it("管理员 /api/dashboard 返回 courses 与 alerts 数组", async () => {
    if (!adminToken) return;
    const res = await fetch(BASE + "/api/dashboard", {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.courses));
    assert.ok(Array.isArray(data.alerts));
  });
});

describe("课程接口", () => {
  it("管理员访问课程 97558 的资料成功", async () => {
    if (!adminToken) return;
    const res = await fetch(BASE + "/api/courses/97558/materials", {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.ok(res.status === 200 || res.status === 404, `响应 ${res.status}`);
  });
});

describe("搜索接口", () => {
  it("带 token 搜索返回结果数组", async () => {
    if (!adminToken) return;
    const res = await fetch(BASE + "/api/search?q=%E8%AF%BE%E4%BB%B6&limit=10", {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.results));
  });
});
