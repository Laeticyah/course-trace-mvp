"use strict";

/**
 * 多渠道资料导入测试
 * 覆盖：渠道注册表、链接导入（网盘）、SSRF/类型校验、批量上传。
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { getBase, startServer, stopServer, seedFixtures, login, auth } = require("./helpers");

const PDF_BYTES = Buffer.from("%PDF-1.4\n渠道导入测试\n%%EOF\n");
let fileServer = null;
let fileBase = "";
let adminToken = null;
let teacherToken = null;

function startFileServer() {
  return new Promise((resolve) => {
    fileServer = http.createServer((req, res) => {
      if (req.url === "/lecture.pdf") {
        res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": PDF_BYTES.length });
        res.end(PDF_BYTES);
      } else {
        res.writeHead(404);
        res.end("not found");
      }
    });
    fileServer.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${fileServer.address().port}`));
  });
}

async function importUrl(token, body) {
  const res = await fetch(getBase() + "/api/import/url", {
    method: "POST",
    headers: auth(token, { "Content-Type": "application/json" }),
    body: JSON.stringify(body)
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

before(async () => {
  await startServer();
  seedFixtures();
  fileBase = await startFileServer();
  adminToken = await login("admin", "admin123");
  teacherToken = await login("teacher", "teacher123");
});
after(async () => {
  await stopServer();
  if (fileServer) fileServer.close();
});

describe("资料来源渠道注册表", () => {
  it("返回多渠道且包含权威度信息", async () => {
    const res = await fetch(getBase() + "/api/sources", { headers: auth(adminToken) });
    assert.equal(res.status, 200);
    const data = await res.json();
    const ids = data.sources.map((source) => source.id);
    for (const id of ["canvas", "teacher", "zhitu", "class", "pan"]) assert.ok(ids.includes(id), id);
    assert.ok(data.sources.every((source) => typeof source.authority === "number"));
  });
});

describe("链接导入（网盘/班级群直链）", () => {
  it("教师从链接导入资料并可与已有资料去重", async () => {
    const first = await importUrl(teacherToken, {
      course: "eng101",
      url: fileBase + "/lecture.pdf",
      name: "第 6 章｜网盘导入课件.pdf",
      type: "课件",
      source: "网盘"
    });
    assert.equal(first.status, 201, JSON.stringify(first.data).slice(0, 200));
    assert.equal(first.data.material.source, "网盘");
    assert.ok(first.data.material.filePath);

    const download = await fetch(getBase() + "/api/materials/" + encodeURIComponent(first.data.material.id) + "/file", { headers: auth(teacherToken) });
    assert.equal(download.status, 200);
    const bytes = Buffer.from(await download.arrayBuffer());
    assert.equal(bytes.length, PDF_BYTES.length);

    const duplicate = await importUrl(teacherToken, {
      course: "eng101",
      url: fileBase + "/lecture.pdf",
      name: "同一份文件的另一个名字.pdf",
      type: "课件",
      source: "班级群"
    });
    assert.equal(duplicate.data.duplicate, true);
  });

  it("拦截内网地址（SSRF）", async () => {
    const res = await importUrl(teacherToken, {
      course: "eng101",
      url: "http://10.0.0.1/internal.pdf",
      name: "内网文件.pdf",
      type: "课件",
      source: "网盘"
    });
    assert.equal(res.status, 400);
    assert.match(res.data.message || "", /内网/);
  });

  it("拒绝不支持的链接文件类型", async () => {
    const res = await importUrl(teacherToken, {
      course: "eng101",
      url: fileBase + "/malware.exe",
      name: "恶意文件.exe",
      type: "课件",
      source: "网盘"
    });
    assert.equal(res.status, 400);
    assert.match(res.data.message || "", /类型/);
  });

  it("拒绝未知来源渠道", async () => {
    const res = await importUrl(teacherToken, {
      course: "eng101",
      url: fileBase + "/lecture.pdf",
      name: "未知来源.pdf",
      type: "课件",
      source: "随便写的来源"
    });
    assert.equal(res.status, 400);
  });
});

describe("批量上传（班级群/网盘一批文件）", () => {
  it("一次上传多个文件并全部入库", async () => {
    const form = new FormData();
    form.append("course", "eng101");
    form.append("type", "课件");
    form.append("source", "班级群");
    form.append("name", "班级群课件");
    form.append("files", new Blob([Buffer.from("batch file 1")], { type: "text/plain" }), "b1.txt");
    form.append("files", new Blob([Buffer.from("batch file 2")], { type: "text/plain" }), "b2.txt");
    const res = await fetch(getBase() + "/api/materials/upload-batch", { method: "POST", headers: auth(teacherToken), body: form });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.results.length, 2);
    assert.equal(data.results.filter((item) => !item.error).length, 2);
    assert.ok(data.results.every((item) => item.materialId));
  });
});
