"use strict";

/**
 * 测试辅助：启动一个隔离的 server（临时 SQLite 库 + 临时 uploads + 随机端口）。
 * 每个测试文件在自己的进程里运行，各自拿到独立实例，互不影响，也不会碰到开发库。
 */

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");

let serverProcess = null;
let tempDir = null;
let base = null;

function getBase() {
  if (!base) throw new Error("测试服务尚未启动");
  return base;
}

async function startServer() {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "course-trace-test-"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = `http://127.0.0.1:${port}`;
  let stderr = "";
  serverProcess = execFile(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DB_FILE: path.join(tempDir, "test.sqlite"),
      UPLOAD_DIR: path.join(tempDir, "uploads"),
      NODE_ENV: "test"
    }
  });
  if (serverProcess.stderr) serverProcess.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  if (serverProcess.stdout) serverProcess.stdout.on("data", () => {});

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode != null) {
      throw new Error("测试服务提前退出：" + stderr.slice(-800));
    }
    try {
      const res = await fetch(base + "/api/health");
      if (res.ok) return base;
    } catch (_) { /* 等待端口就绪 */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("测试服务启动超时：" + stderr.slice(-800));
}

async function stopServer() {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
  if (tempDir) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) { /* 忽略清理失败 */ }
    tempDir = null;
  }
  base = null;
}

async function login(username, password) {
  const res = await fetch(getBase() + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  if (!res.ok) throw new Error(`登录失败 ${username}: ${res.status}`);
  return (await res.json()).token;
}

function auth(token, extra) {
  return Object.assign({ Authorization: `Bearer ${token}` }, extra || {});
}

async function uploadMaterial(token, { name, course, type = "课件", source = "Canvas", fileName = "test.txt", content = "版本治理 测试内容" }) {
  const form = new FormData();
  form.append("name", name);
  form.append("course", course);
  form.append("type", type);
  form.append("source", source);
  form.append("file", new Blob([content], { type: "text/plain" }), fileName);
  const res = await fetch(getBase() + "/api/materials/upload", {
    method: "POST",
    headers: auth(token),
    body: form
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

module.exports = { ROOT, getBase, startServer, stopServer, login, auth, uploadMaterial };
