"use strict";

/**
 * 接口测试 · REST API（隔离实例：临时 SQLite + 临时 uploads + 随机端口）
 * 运行方式: npm run test:api
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { getBase, startServer, stopServer, login, auth } = require("./helpers");

let adminToken = null;
let studentToken = null;

before(async () => { await startServer(); });
after(async () => { await stopServer(); });

describe("健康检查", () => {
  it("GET /api/health 返回 200 且 ok:true", async () => {
    const res = await fetch(getBase() + "/api/health");
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(data.service);
  });
});

describe("认证", () => {
  it("未认证访问 /api/dashboard 返回 401", async () => {
    const res = await fetch(getBase() + "/api/dashboard");
    assert.equal(res.status, 401);
  });

  it("管理员与测试账号登录成功", async () => {
    adminToken = await login("admin", "admin123");
    studentToken = await login("student", "student123");
    assert.ok(adminToken);
    assert.ok(studentToken);
  });

  it("登出后 token 失效", async () => {
    const token = await login("student", "student123");
    const logout = await fetch(getBase() + "/api/auth/logout", { method: "POST", headers: auth(token) });
    assert.equal(logout.status, 204);
    const me = await fetch(getBase() + "/api/auth/me", { headers: auth(token) });
    assert.equal(me.status, 401);
  });
});

describe("仪表盘与课程", () => {
  it("管理员拿到 courses / alerts", async () => {
    const res = await fetch(getBase() + "/api/dashboard", { headers: auth(adminToken) });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.courses));
    assert.ok(data.courses.length >= 3);
    assert.ok(Array.isArray(data.alerts));
  });

  it("学生只看到已加入课程（eng101）", async () => {
    const res = await fetch(getBase() + "/api/dashboard", { headers: auth(studentToken) });
    const data = await res.json();
    const ids = data.courses.map((course) => course.id);
    assert.ok(ids.includes("eng101"));
    assert.ok(!ids.includes("math101"));
  });

  it("管理员读取 eng101 资料成功", async () => {
    const res = await fetch(getBase() + "/api/courses/eng101/materials", { headers: auth(adminToken) });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.materials));
  });

  it("学生可以加入/退出课程（成员角色 CHECK 已修复）", async () => {
    const join = await fetch(getBase() + "/api/courses/math101/join", { method: "POST", headers: auth(studentToken) });
    assert.equal(join.status, 201);
    let dash = await (await fetch(getBase() + "/api/dashboard", { headers: auth(studentToken) })).json();
    assert.ok(dash.courses.map((course) => course.id).includes("math101"));

    const leave = await fetch(getBase() + "/api/courses/math101/leave", { method: "DELETE", headers: auth(studentToken) });
    assert.equal(leave.status, 204);
    dash = await (await fetch(getBase() + "/api/dashboard", { headers: auth(studentToken) })).json();
    assert.ok(!dash.courses.map((course) => course.id).includes("math101"));
  });

  it("访问不存在的课程返回 404", async () => {
    const res = await fetch(getBase() + "/api/courses/no-such-course/materials", { headers: auth(adminToken) });
    assert.equal(res.status, 404);
  });
});

describe("搜索", () => {
  it("中文关键词可检索到资料", async () => {
    const res = await fetch(getBase() + "/api/search?q=" + encodeURIComponent("需求分析") + "&limit=10", { headers: auth(adminToken) });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.results));
    assert.ok(data.count > 0, "中文检索应有结果");
  });
});
