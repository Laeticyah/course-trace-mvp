"use strict";

/**
 * 安全与权限测试（隔离实例）
 * 覆盖：静态资源白名单、上传/下载鉴权、路径穿越、跨课程越权、版本归档、中文检索。
 * 运行方式: npm run test:api
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { getBase, startServer, stopServer, seedFixtures, login, auth, uploadMaterial } = require("./helpers");

const CONTENT_MARKER = "SECURITY-CHECK-CONTENT";
const UPLOAD_NAME = "阶段1权限验证资料";

let adminToken = null;
let teacherToken = null;
let studentToken = null;
let uploaded = null;

before(async () => {
  await startServer();
  seedFixtures();
  adminToken = await login("admin", "admin123");
  teacherToken = await login("teacher", "teacher123");
  studentToken = await login("student", "student123");
});
after(async () => { await stopServer(); });

describe("静态资源白名单", () => {
  it("前端资源可访问", async () => {
    for (const file of ["/", "/index.html", "/app.js", "/styles.css", "/ux-polish.js", "/enhancements.js"]) {
      const res = await fetch(getBase() + file);
      assert.equal(res.status, 200, file);
    }
  });

  it("数据库 / 源码 / 上传目录 / node_modules 不再暴露", async () => {
    for (const file of ["/course-trace.sqlite", "/server.js", "/database.js", "/data.json", "/uploads/eng101/anything.pdf", "/node_modules/express/package.json"]) {
      const res = await fetch(getBase() + file);
      assert.equal(res.status, 404, file);
    }
  });
});

describe("上传与下载", () => {
  it("未登录上传 401，学生上传 403", async () => {
    const anon = await fetch(getBase() + "/api/materials/upload", { method: "POST" });
    assert.equal(anon.status, 401);
    const studentUpload = await uploadMaterial(studentToken, { name: "学生上传", course: "eng101", content: "x" });
    assert.equal(studentUpload.status, 403);
  });

  it("教师在自己课程上传成功（V1.0）", async () => {
    uploaded = await uploadMaterial(teacherToken, { name: UPLOAD_NAME, course: "eng101", content: CONTENT_MARKER });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.data).slice(0, 200));
    assert.equal(uploaded.data.material.version, "V1.0");
    assert.ok(uploaded.data.material.filePath);
  });

  it("按资料 id 下载：带 token 200 且内容一致，未登录 401", async () => {
    const res = await fetch(getBase() + "/api/materials/" + encodeURIComponent(uploaded.data.material.id) + "/file", { headers: auth(teacherToken) });
    assert.equal(res.status, 200);
    const text = Buffer.from(await res.arrayBuffer()).toString("utf8");
    assert.ok(text.includes(CONTENT_MARKER), "下载内容应与上传一致");

    const anon = await fetch(getBase() + "/api/materials/" + encodeURIComponent(uploaded.data.material.id) + "/file");
    assert.equal(anon.status, 401);
  });

  it("同内容的重复上传被识别为 duplicate", async () => {
    const dup = await uploadMaterial(teacherToken, { name: "重复内容验证", course: "eng101", content: CONTENT_MARKER });
    assert.equal(dup.data.duplicate, true);
  });

  it("第二次上传生成 V2.0，旧版本自动归档且不再是权威版", async () => {
    const second = await uploadMaterial(teacherToken, { name: UPLOAD_NAME, course: "eng101", content: CONTENT_MARKER + "-V2" });
    assert.equal(second.status, 201);
    assert.equal(second.data.material.version, "V2.0");

    const dash = await (await fetch(getBase() + "/api/dashboard", { headers: auth(teacherToken) })).json();
    const eng = dash.courses.find((course) => course.id === "eng101");
    const versions = eng.materials.filter((m) => m.name === UPLOAD_NAME);
    assert.equal(versions.length, 2);
    const archived = versions.filter((m) => m.status === "archived");
    assert.equal(archived.length, 1);
    assert.equal(archived[0].statusText, "已归档");
    assert.equal(archived[0].isAuthoritative, false);
    const current = versions.find((m) => m.status !== "archived");
    assert.equal(current.isAuthoritative, true);
  });

  it("教师可审核/归档自己课程的资料", async () => {
    const created = await uploadMaterial(teacherToken, { name: "审核归档流程验证", course: "eng101", content: "review-archive-flow" });
    assert.equal(created.status, 201);
    const id = created.data.material.id;

    const review = await fetch(getBase() + "/api/materials/" + encodeURIComponent(id) + "/review", {
      method: "PUT",
      headers: auth(teacherToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ status: "approved", note: "教师确认" })
    });
    assert.equal(review.status, 200);
    assert.equal((await review.json()).material.reviewStatus, "approved");

    const archive = await fetch(getBase() + "/api/materials/" + encodeURIComponent(id) + "/archive", {
      method: "PUT",
      headers: auth(teacherToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ archived: true })
    });
    assert.equal(archive.status, 200);
    assert.equal((await archive.json()).material.status, "archived");

    const dash = await (await fetch(getBase() + "/api/dashboard", { headers: auth(teacherToken) })).json();
    const material = dash.courses.find((course) => course.id === "eng101").materials.find((m) => m.id === id);
    assert.equal(material.status, "archived");
    assert.equal(material.statusText, "已归档");
  });
});

describe("路径穿越与越权", () => {
  it("courseId 路径穿越被拦截", async () => {
    const res1 = await fetch(getBase() + "/api/courses/..%2F..%2Fetc/files/hosts", { headers: auth(adminToken) });
    assert.ok([400, 404].includes(res1.status), String(res1.status));
    const res2 = await fetch(getBase() + "/api/courses/..%5C..%5C..%5C..%5C..%5CWindows%5CSystem32%5Cdrivers%5Cetc/files/hosts", { headers: auth(adminToken) });
    assert.ok([400, 404].includes(res2.status), String(res2.status));
  });

  it("学生访问未加入课程资料 / 文件列表均为 403", async () => {
    const materials = await fetch(getBase() + "/api/courses/math101/materials", { headers: auth(studentToken) });
    assert.equal(materials.status, 403);
    const files = await fetch(getBase() + "/api/courses/math101/files", { headers: auth(studentToken) });
    assert.equal(files.status, 403);
  });

  it("教师不能操作非自己担任教师的课程（上传/审核/同步）", async () => {
    const membersRes = await fetch(getBase() + "/api/courses/math101/members", { headers: auth(adminToken) });
    assert.equal(membersRes.status, 200);
    const members = (await membersRes.json()).members;
    const teacher = members.find((member) => member.username === "teacher");
    assert.ok(teacher, "math101 初始应有教师成员");
    const removed = await fetch(getBase() + "/api/courses/math101/members/" + encodeURIComponent(teacher.id), { method: "DELETE", headers: auth(adminToken) });
    assert.equal(removed.status, 204);

    const uploadRes = await uploadMaterial(teacherToken, { name: "跨课程上传", course: "math101", content: "cross-course" });
    assert.equal(uploadRes.status, 403);

    const syncRes = await fetch(getBase() + "/api/courses/math101/sync", { method: "POST", headers: auth(teacherToken) });
    assert.equal(syncRes.status, 403);

    const dash = await (await fetch(getBase() + "/api/dashboard", { headers: auth(adminToken) })).json();
    const math = dash.courses.find((course) => course.id === "math101");
    const target = math.materials[0];
    const reviewRes = await fetch(getBase() + "/api/materials/" + encodeURIComponent(target.id) + "/review", {
      method: "PUT",
      headers: auth(teacherToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ status: "approved", note: "越权审核" })
    });
    assert.equal(reviewRes.status, 403);

    const archiveRes = await fetch(getBase() + "/api/materials/" + encodeURIComponent(target.id) + "/archive", {
      method: "PUT",
      headers: auth(teacherToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ archived: true })
    });
    assert.equal(archiveRes.status, 403);
  });
});

describe("中文检索", () => {
  it("中文关键词命中资料", async () => {
    const res = await fetch(getBase() + "/api/search?q=" + encodeURIComponent("需求分析") + "&limit=10", { headers: auth(adminToken) });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.count > 0);
  });

  it("新上传的资料立即可检索", async () => {
    const res = await fetch(getBase() + "/api/search?q=" + encodeURIComponent(UPLOAD_NAME) + "&limit=10", { headers: auth(adminToken) });
    const data = await res.json();
    assert.ok(data.results.some((item) => item.name === UPLOAD_NAME));
  });
});
