"use strict";

/**
 * 同步采集归一化单元测试
 * 重点：Canvas API 的文件字段是 fileUrl，必须映射为下载器使用的 url，
 * 否则真实同步只会建资料记录、不会下载文件。
 */

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "course-trace-sync-unit-"));
process.env.DB_FILE = path.join(tempDir, "unit.sqlite");
process.env.UPLOAD_DIR = path.join(tempDir, "uploads");
process.env.CANVAS_MODE = "mock";

const { normalizeCollection } = require("../../sync-engine");

after(() => {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
});

test("Canvas 条目的 fileUrl 会被映射为下载器使用的 url", () => {
  const [entry] = normalizeCollection([
    {
      name: "第1章-函数-1.pdf",
      fileName: "第1章-函数-1.pdf",
      type: "课件",
      source: "Canvas",
      version: "V1.0",
      date: "2026.09.01",
      size: 586861,
      mime: "application/pdf",
      fileUrl: "https://oc.example.edu/files/1/download"
    }
  ], "97558");

  assert.equal(entry.url, "https://oc.example.edu/files/1/download");
  assert.equal(entry.fileName, "第1章-函数-1.pdf");
  assert.equal(entry.fileSize, 586861);
  assert.equal(entry.name, "第1章-函数-1.pdf");
});

test("兼容旧字段 url，并保留空值", () => {
  const [oldEntry] = normalizeCollection([{ name: "旧字段资料", url: "https://example.com/a.pdf" }], "c1");
  assert.equal(oldEntry.url, "https://example.com/a.pdf");

  const [noUrl] = normalizeCollection([{ name: "公告：无附件", type: "通知" }], "c1");
  assert.equal(noUrl.url, null);
});
