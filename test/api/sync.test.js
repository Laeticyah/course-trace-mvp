"use strict";

/**
 * Canvas 同步链路测试（隔离实例，固定 mock 采集）
 * 覆盖：触发权限、任务生命周期、结果落库、任务列表/日志鉴权、SSE 鉴权。
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { getBase, startServer, stopServer, login, auth } = require("./helpers");

let adminToken = null;
let teacherToken = null;
let studentToken = null;
let syncJob = null;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJob(token, id) {
  const res = await fetch(getBase() + "/api/sync-jobs/" + encodeURIComponent(id), { headers: auth(token) });
  return { status: res.status, data: await res.json() };
}

async function waitForJob(token, id, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const current = await getJob(token, id);
    last = current;
    if (current.status === 200 && ["success", "failed", "cancelled"].includes(current.data.job.status)) {
      return current.data.job;
    }
    await wait(200);
  }
  throw new Error("同步任务未在超时内结束: " + JSON.stringify(last));
}

before(async () => {
  await startServer();
  adminToken = await login("admin", "admin123");
  teacherToken = await login("teacher", "teacher123");
  studentToken = await login("student", "student123");
});
after(async () => { await stopServer(); });

describe("同步任务触发权限", () => {
  it("未登录 / 学生不能触发同步", async () => {
    const anon = await fetch(getBase() + "/api/courses/eng101/sync", { method: "POST" });
    assert.equal(anon.status, 401);
    const student = await fetch(getBase() + "/api/courses/eng101/sync", { method: "POST", headers: auth(studentToken) });
    assert.equal(student.status, 403);
  });

  it("教师触发的任务至少进入执行队列", async () => {
    const res = await fetch(getBase() + "/api/courses/eng101/sync", { method: "POST", headers: auth(teacherToken) });
    assert.equal(res.status, 202);
    const data = await res.json();
    assert.ok(data.job && data.job.id);
    assert.equal(data.job.status, "pending");
    syncJob = data.job;
  });
});

describe("同步任务生命周期", () => {
  it("任务最终成功并写入结果统计", async () => {
    const job = await waitForJob(teacherToken, syncJob.id);
    assert.equal(job.status, "success", JSON.stringify(job));
    assert.equal(job.progress, 100);
    assert.ok(job.result, "应持久化 result 统计");
    assert.ok(job.result.added >= 1, "mock 采集应至少新增一条资料: " + JSON.stringify(job.result));
    assert.ok(job.attempts >= 1, "应记录尝试次数");
  });

  it("同步产生的资料出现在课程资料列表", async () => {
    const res = await fetch(getBase() + "/api/courses/eng101/materials", { headers: auth(teacherToken) });
    const data = await res.json();
    assert.ok(data.materials.some((item) => item.source === "Canvas" && item.name.includes("课程同步资料")));
  });

  it("再次同步同版本资料时跳过，不重复建档", async () => {
    const res = await fetch(getBase() + "/api/courses/eng101/sync", { method: "POST", headers: auth(teacherToken) });
    assert.equal(res.status, 202);
    const { job } = await res.json();
    const done = await waitForJob(teacherToken, job.id);
    assert.equal(done.status, "success");
    assert.ok(done.result.skipped >= 1, "同版本应被跳过: " + JSON.stringify(done.result));
  });

  it("任务日志可读，且只有相关教师/管理员可读", async () => {
    const logs = await fetch(getBase() + "/api/sync-jobs/" + encodeURIComponent(syncJob.id) + "/logs", { headers: auth(teacherToken) });
    assert.equal(logs.status, 200);
    const data = await logs.json();
    assert.ok(Array.isArray(data.logs) && data.logs.length > 0);

    const studentLogs = await fetch(getBase() + "/api/sync-jobs/" + encodeURIComponent(syncJob.id) + "/logs", { headers: auth(studentToken) });
    assert.equal(studentLogs.status, 403);
  });

  it("任务列表对学生不可见", async () => {
    const student = await fetch(getBase() + "/api/sync-jobs", { headers: auth(studentToken) });
    assert.equal(student.status, 403);
    const teacher = await fetch(getBase() + "/api/sync-jobs", { headers: auth(teacherToken) });
    assert.equal(teacher.status, 200);
    const admin = await fetch(getBase() + "/api/sync-jobs", { headers: auth(adminToken) });
    assert.equal(admin.status, 200);
  });
});

describe("SSE 进度流鉴权", () => {
  it("未带 token 访问 events 返回 401", async () => {
    const res = await fetch(getBase() + "/api/sync-jobs/" + encodeURIComponent(syncJob.id) + "/events");
    assert.equal(res.status, 401);
  });

  it("教师可建立 SSE 连接并收到初始数据", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const res = await fetch(getBase() + "/api/sync-jobs/" + encodeURIComponent(syncJob.id) + "/events", {
        headers: auth(teacherToken),
        signal: controller.signal
      });
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
      const reader = res.body.getReader();
      let text = "";
      for (let i = 0; i < 3 && !text.includes("data:"); i++) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += Buffer.from(chunk.value || []).toString("utf8");
      }
      assert.match(text, /data:/);
      await reader.cancel().catch(() => {});
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  });
});
