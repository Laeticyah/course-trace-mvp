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
      // 测试不访问真实 Canvas：置空 Token，让同步任务明确失败（成功链路用真实环境手工验证）
      CANVAS_TOKEN: "",
      CANVAS_BASE_URL: "http://127.0.0.1:1",
      // 仅测试允许链接导入访问本机文件服务，生产默认禁止内网地址
      IMPORT_ALLOW_PRIVATE_HOSTS: "127.0.0.1",
      NODE_ENV: "test"
    }
  });
  if (serverProcess.stderr) serverProcess.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
    if (process.env.DEBUG_TEST_SERVER) console.error("[test-server]", chunk.toString().trim());
  });
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

/**
 * 测试用最小数据：真实数据由 Canvas 同步/上传产生，这里只为接口测试准备固定的课程与成员。
 * 在服务启动后写入同一个临时 SQLite（服务端每次请求都实时读库）。
 */
function seedFixtures() {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(tempDir, "test.sqlite"), { timeout: 5000 });
  const now = new Date().toISOString();
  const insertCourse = db.prepare("INSERT OR REPLACE INTO courses (id, code, name, description, color, progress, official_count, updates) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const insertMaterial = db.prepare(`INSERT OR REPLACE INTO materials (
    id, course_id, name, type, source, version, date, status, status_text, icon,
    version_chain_id, is_authoritative, review_status
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertMember = db.prepare("INSERT OR REPLACE INTO course_members (course_id, user_id, member_role, joined_at) VALUES (?, ?, ?, ?)");
  const courses = [
    ["eng101", "ENG 101", "工程学导论", "Engineering Fundamentals", "blue", 72, 1, "刚刚更新"],
    ["math101", "MATH 101", "高等数学 I", "Advanced Mathematics", "orange", 54, 1, "刚刚更新"],
    ["ai101", "AI 101", "人工智能导论", "Introduction to AI", "green", 81, 1, "刚刚更新"]
  ];
  const materials = [
    ["fixture-m1", "eng101", "第 3 章｜需求分析与问题定位", "课件", "Canvas", "V3.0", "2026.10.15", "official", "最新权威版", "▤", "fixture-chain-1"],
    ["fixture-m2", "eng101", "项目建议书评分标准", "作业要求", "Canvas", "V2.1", "2026.10.12", "official", "官方资料", "▣", "fixture-chain-2"],
    ["fixture-m3", "eng101", "答辩重点与个人分工整理", "复习笔记", "班级群", "V1.0", "2026.10.08", "student", "学生整理", "✎", "fixture-chain-3"],
    ["fixture-m4", "math101", "第 5 章｜定积分应用", "课件", "知途好课", "V2.0", "2026.10.13", "official", "官方资料", "▤", "fixture-chain-4"],
    ["fixture-m5", "math101", "期中复习范围说明", "作业要求", "Canvas", "V1.0", "2026.10.01", "official", "官方资料", "▣", "fixture-chain-5"],
    ["fixture-m6", "ai101", "第 2 章｜机器学习概览", "课件", "Canvas", "V4.0", "2026.10.10", "official", "官方资料", "▤", "fixture-chain-6"]
  ];
  let attempt = 0;
  for (;;) {
    try {
      db.exec("BEGIN IMMEDIATE");
      for (const course of courses) insertCourse.run(...course);
      for (const m of materials) {
        insertMaterial.run(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], 1, "pending");
      }
      insertMember.run("eng101", "teacher-demo", "teacher", now);
      insertMember.run("math101", "teacher-demo", "teacher", now);
      insertMember.run("ai101", "teacher-demo", "teacher", now);
      insertMember.run("eng101", "student-demo", "student", now);
      db.exec("COMMIT");
      break;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch (_) { /* ignore */ }
      if (++attempt > 20) { db.close(); throw error; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    }
  }
  db.close();
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

module.exports = { ROOT, getBase, startServer, stopServer, seedFixtures, login, auth, uploadMaterial };
