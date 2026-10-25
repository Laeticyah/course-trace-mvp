"use strict";

/**
 * 清理演示数据：删除种子演示课程、演示提醒，以及没有真实本地文件的资料。
 * 运行：npm run cleanup:demo
 * 会先把数据库备份到 backups/ 下（VACUUM INTO，且不会阻塞正在运行的服务）。
 */

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.resolve(__dirname, "..");
const dbFile = process.env.DB_FILE ? path.resolve(process.env.DB_FILE) : path.join(ROOT, "course-trace.sqlite");
const uploadDir = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(ROOT, "uploads");
const DEMO_COURSE_IDS = ["eng101", "math101", "ai101"];
const DEMO_COURSE_NAMES = ["工程学导论", "高等数学 I", "人工智能导论"];

if (!fs.existsSync(dbFile)) {
  console.error("[cleanup] 数据库不存在:", dbFile);
  process.exit(1);
}

const backupDir = path.join(ROOT, "backups");
fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupFile = path.join(backupDir, `course-trace-${stamp}.sqlite`);

const db = new DatabaseSync(dbFile, { timeout: 5000 });
db.exec(`VACUUM INTO '${backupFile.replace(/'/g, "''")}'`);
console.log("[cleanup] 已备份数据库到", backupFile);

let removedCourses = 0;
let removedAlerts = 0;
let removedMaterials = 0;
let removedFiles = 0;

db.exec("BEGIN IMMEDIATE");
try {
  const deleteCourse = db.prepare("DELETE FROM courses WHERE id = ?");
  for (const id of DEMO_COURSE_IDS) {
    removedCourses += deleteCourse.run(id).changes;
  }
  const deleteAlert = db.prepare("DELETE FROM alerts WHERE course = ?");
  for (const name of DEMO_COURSE_NAMES) {
    removedAlerts += deleteAlert.run(name).changes;
  }

  // 没有本地文件、或文件已丢失的资料不保留
  const materials = db.prepare("SELECT id, file_path FROM materials").all();
  const deleteMaterial = db.prepare("DELETE FROM materials WHERE id = ?");
  for (const material of materials) {
    if (!material.file_path) {
      removedMaterials += deleteMaterial.run(material.id).changes;
      continue;
    }
    const absolute = path.isAbsolute(material.file_path)
      ? path.resolve(material.file_path)
      : path.resolve(ROOT, material.file_path);
    // 兼容自定义 UPLOAD_DIR：把 uploads/ 前缀映射到当前上传目录
    const relativeToUploads = path.relative(path.join(ROOT, "uploads"), absolute);
    const mapped = relativeToUploads.startsWith("..") ? null : path.resolve(uploadDir, relativeToUploads);
    if (!fs.existsSync(absolute) && !(mapped && fs.existsSync(mapped))) {
      removedMaterials += deleteMaterial.run(material.id).changes;
    }
  }

  // 清理演示账号的课程成员关系（课程本身已删除，这里兜底）
  db.prepare("DELETE FROM course_members WHERE course_id IN ('eng101','math101','ai101')").run();
  // 账号保留，但去掉演示化的展示名
  const renameUser = db.prepare("UPDATE users SET display_name = ? WHERE username = ?");
  renameUser.run("学生", "student");
  renameUser.run("教师", "teacher");
  renameUser.run("管理员", "admin");
  db.exec("COMMIT");
} catch (error) {
  try { db.exec("ROLLBACK"); } catch (_) { /* ignore */ }
  console.error("[cleanup] 清理失败:", error.message);
  process.exit(1);
}

// 清理演示截图等非资料文件（真实资料文件在 uploads/<courseId>/ 下，不动）
for (const name of fs.readdirSync(uploadDir)) {
  if (!/^verify-.*\.png$/i.test(name)) continue;
  try { fs.rmSync(path.join(uploadDir, name)); removedFiles++; } catch (_) { /* ignore */ }
}

const remainingCourses = db.prepare("SELECT id, name FROM courses ORDER BY id").all();
const remainingMaterials = db.prepare("SELECT COUNT(*) AS n FROM materials").get().n;
const remainingAlerts = db.prepare("SELECT COUNT(*) AS n FROM alerts").get().n;
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
db.close();

console.log("[cleanup] 删除课程:", removedCourses, "提醒:", removedAlerts, "资料:", removedMaterials, "演示图片:", removedFiles);
console.log("[cleanup] 保留课程:", remainingCourses.map((course) => `${course.id}/${course.name}`).join(", ") || "(无)");
console.log("[cleanup] 保留资料:", remainingMaterials, "提醒:", remainingAlerts);
