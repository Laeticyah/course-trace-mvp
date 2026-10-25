"use strict";

/**
 * Canvas 文件下载单元测试
 * 覆盖：真实文件落盘、filePath/fileHash/fileSize 回填、增量跳过。
 * （此前 downloadIncremental 缺失曾导致导入任务全部失败，这里做回归保护。）
 */

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "course-trace-download-unit-"));
process.env.DB_FILE = path.join(tempDir, "unit.sqlite");
process.env.UPLOAD_DIR = path.join(tempDir, "uploads");
process.env.CANVAS_TOKEN = "";

const { createSyncJob } = require("../../database");
const { downloadIncremental } = require("../../sync-engine");

const fileBytes = Buffer.from("%PDF-1.4\n课脉下载单元测试\n%%EOF\n");

let server = null;
after(() => {
  if (server) server.close();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
});

function startFileServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      if (req.url === "/demo.pdf") {
        res.writeHead(200, { "Content-Type": "application/pdf" });
        res.end(fileBytes);
      } else {
        res.writeHead(404);
        res.end("not found");
      }
    });
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

test("下载 Canvas 文件并回填本地信息，重复下载会跳过", async () => {
  const base = await startFileServer();
  const job = createSyncJob({ courseId: null, scope: "global", createdBy: null });
  const entries = [
    { name: "讲义.pdf", fileName: "讲义.pdf", url: `${base}/demo.pdf` },
    { name: "无地址资料.pdf", url: null }
  ];

  const count = await downloadIncremental("unit-course", entries, job.id);
  assert.equal(count, 1);
  assert.ok(entries[0].filePath, "应回填 filePath");
  assert.equal(entries[0].fileSize, fileBytes.length);
  assert.match(entries[0].fileHash, /^[0-9a-f]{64}$/);

  const absolute = path.resolve(__dirname, "..", "..", entries[0].filePath);
  assert.ok(fs.existsSync(absolute), "下载文件应落盘: " + absolute);
  assert.equal(fs.readFileSync(absolute).length, fileBytes.length);

  const again = await downloadIncremental("unit-course", entries, job.id);
  assert.equal(again, 0, "已存在的文件应跳过");
});
