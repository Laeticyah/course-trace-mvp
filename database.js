const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const crypto = require("node:crypto");

const databaseFile = path.join(__dirname, "course-trace.sqlite");
const legacyDataFile = path.join(__dirname, "data.json");
const db = new DatabaseSync(databaseFile);

db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
db.exec(`
  CREATE TABLE IF NOT EXISTS courses (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    color TEXT NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0,
    official_count INTEGER NOT NULL DEFAULT 0,
    updates TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS materials (
    id TEXT PRIMARY KEY,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    source TEXT NOT NULL,
    version TEXT NOT NULL,
    date TEXT NOT NULL,
    status TEXT NOT NULL,
    status_text TEXT NOT NULL,
    icon TEXT NOT NULL,
    file_hash TEXT,
    file_name TEXT,
    file_size INTEGER,
    file_path TEXT,
    version_chain_id TEXT NOT NULL,
    extracted_text TEXT,
    similarity REAL,
    version_reason TEXT,
    authority_score REAL,
    authority_breakdown TEXT,
    is_authoritative INTEGER NOT NULL DEFAULT 0,
    review_status TEXT NOT NULL DEFAULT 'pending',
    reviewed_by TEXT,
    reviewed_at TEXT,
    review_note TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_materials_course ON materials(course_id);
  CREATE INDEX IF NOT EXISTS idx_materials_hash ON materials(file_hash);
  CREATE INDEX IF NOT EXISTS idx_materials_chain ON materials(version_chain_id);
  CREATE TABLE IF NOT EXISTS material_versions (
    id TEXT PRIMARY KEY,
    chain_id TEXT NOT NULL,
    material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
    version_num INTEGER NOT NULL,
    file_hash TEXT,
    created_by TEXT NOT NULL,
    change_note TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_material_versions_chain ON material_versions(chain_id);
  CREATE INDEX IF NOT EXISTS idx_material_versions_material ON material_versions(material_id);
  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    time TEXT NOT NULL,
    course TEXT NOT NULL,
    unread INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('student', 'teacher', 'admin')),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS course_members (
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    member_role TEXT NOT NULL CHECK (member_role IN ('teacher')),
    joined_at TEXT NOT NULL,
    PRIMARY KEY (course_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_course_members_user ON course_members(user_id);
`);

// ---- FTS5 全文搜索 ----
// 说明: 使用独立的内容表 + 触发器维护，避免外部内容表对 schema 的强依赖。
// 缺失时优雅降级为 LIKE 查询。
let ftsAvailable = false;
function initFTS() {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS materials_fts USING fts5(
        name, type, source, course_name,
        tokenize='unicode61'
      );
    `);
    // 判断是否已同步, 如果虚拟表为空则从 materials 全量导入
    const count = db.prepare("SELECT COUNT(*) AS n FROM materials_fts").get().n;

    ftsAvailable = true;
    if (count === 0) {
      db.exec(`
        INSERT INTO materials_fts(rowid, name, type, source, course_name)
        SELECT m.rowid, m.name, m.type, m.source, c.name
        FROM materials m JOIN courses c ON c.id = m.course_id
      `);
    }
  } catch (e) {
    console.warn("[database] FTS5 不可用，已降级为 LIKE 搜索:", e.message);
  }
}
initFTS();

const materialColumns = db.prepare("PRAGMA table_info(materials)").all().map(column => column.name);
for (const statement of [
  ["review_status", "ALTER TABLE materials ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending'"],
  ["reviewed_by", "ALTER TABLE materials ADD COLUMN reviewed_by TEXT"],
  ["reviewed_at", "ALTER TABLE materials ADD COLUMN reviewed_at TEXT"],
  ["review_note", "ALTER TABLE materials ADD COLUMN review_note TEXT"]
]) {
  if (!materialColumns.includes(statement[0])) db.exec(statement[1]);
}

function materialToRow(material, courseId) {
  return {
    id: material.id || require("node:crypto").randomUUID(),
    courseId,
    name: material.name,
    type: material.type,
    source: material.source,
    version: material.version || "V1.0",
    date: material.date,
    status: material.status,
    statusText: material.statusText,
    icon: material.icon || "▤",
    fileHash: material.fileHash || null,
    fileName: material.fileName || null,
    fileSize: material.fileSize || null,
    filePath: material.filePath || null,
    versionChainId: material.versionChainId || `${material.name}:${material.type}`,
    extractedText: material.extractedText ? JSON.stringify(material.extractedText) : null,
    similarity: material.similarity ?? null,
    versionReason: material.versionReason || null,
    authorityScore: material.authorityScore ?? null,
    authorityBreakdown: material.authorityBreakdown ? JSON.stringify(material.authorityBreakdown) : null,
    isAuthoritative: material.isAuthoritative ? 1 : 0,
    reviewStatus: material.reviewStatus || "pending",
    reviewedBy: material.reviewedBy || null,
    reviewedAt: material.reviewedAt || null,
    reviewNote: material.reviewNote || null
  };
}

function rowToMaterial(row) {
  return {
    id: row.id, name: row.name, type: row.type, source: row.source,
    version: row.version, date: row.date, status: row.status,
    statusText: row.status_text, icon: row.icon, fileHash: row.file_hash,
    fileName: row.file_name, fileSize: row.file_size, filePath: row.file_path,
    versionChainId: row.version_chain_id,
    extractedText: row.extracted_text ? JSON.parse(row.extracted_text) : null,
    similarity: row.similarity, versionReason: row.version_reason,
    authorityScore: row.authority_score,
    authorityBreakdown: row.authority_breakdown ? JSON.parse(row.authority_breakdown) : null,
    isAuthoritative: Boolean(row.is_authoritative),
    reviewStatus: row.review_status || "pending",
    reviewedBy: row.reviewed_by || null,
    reviewedAt: row.reviewed_at || null,
    reviewNote: row.review_note || null
  };
}

function readData() {
  const courses = db.prepare("SELECT * FROM courses ORDER BY rowid").all().map(course => {
    const materials = db.prepare("SELECT * FROM materials WHERE course_id = ? ORDER BY rowid DESC").all(course.id).map(rowToMaterial);
    return {
      id: course.id, code: course.code, name: course.name, desc: course.description,
      color: course.color, count: materials.length, progress: course.progress,
      official: course.official_count, updates: course.updates, materials
    };
  });
  const alerts = db.prepare("SELECT * FROM alerts ORDER BY id DESC").all().map(alert => ({
    title: alert.title, desc: alert.description, time: alert.time,
    course: alert.course, unread: Boolean(alert.unread)
  }));
  return { courses, alerts };
}

function writeData(data) {
  const transaction = () => {
    const memberships = db.prepare("SELECT * FROM course_members").all();
    db.prepare("DELETE FROM materials").run();
    db.prepare("DELETE FROM course_members").run();
    db.prepare("DELETE FROM courses").run();
    db.prepare("DELETE FROM alerts").run();
    const insertCourse = db.prepare(`
      INSERT INTO courses (id, code, name, description, color, progress, official_count, updates)
      VALUES (@id, @code, @name, @description, @color, @progress, @official, @updates)
    `);
    const insertMaterial = db.prepare(`
      INSERT INTO materials (
        id, course_id, name, type, source, version, date, status, status_text, icon,
        file_hash, file_name, file_size, file_path, version_chain_id, extracted_text,
        similarity, version_reason, authority_score, authority_breakdown, is_authoritative
        , review_status, reviewed_by, reviewed_at, review_note
      ) VALUES (
        @id, @courseId, @name, @type, @source, @version, @date, @status, @statusText, @icon,
        @fileHash, @fileName, @fileSize, @filePath, @versionChainId, @extractedText,
        @similarity, @versionReason, @authorityScore, @authorityBreakdown, @isAuthoritative,
        @reviewStatus, @reviewedBy, @reviewedAt, @reviewNote
      )
    `);
    for (const course of data.courses) {
      insertCourse.run({
        id: course.id, code: course.code, name: course.name, description: course.desc,
        color: course.color, progress: course.progress, official: course.official, updates: course.updates
      });
      for (const material of course.materials) insertMaterial.run(materialToRow(material, course.id));
    }
    const insertMember = db.prepare("INSERT OR IGNORE INTO course_members (course_id, user_id, member_role, joined_at) VALUES (?, ?, ?, ?)");
    for (const member of memberships) {
      if (data.courses.some(course => course.id === member.course_id)) {
        insertMember.run(member.course_id, member.user_id, member.member_role, member.joined_at);
      }
    }
    const insertAlert = db.prepare("INSERT INTO alerts (title, description, time, course, unread) VALUES (?, ?, ?, ?, ?)");
    for (const alert of data.alerts) insertAlert.run(alert.title, alert.desc, alert.time, alert.course, alert.unread ? 1 : 0);
  };
  transaction();
}

if (db.prepare("SELECT COUNT(*) AS count FROM courses").get().count === 0 && fs.existsSync(legacyDataFile)) {
  writeData(JSON.parse(fs.readFileSync(legacyDataFile, "utf8")));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, expected] = String(stored).split(":");
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function seedUsers() {
  if (db.prepare("SELECT COUNT(*) AS count FROM users").get().count > 0) return;
  const insert = db.prepare(`
    INSERT INTO users (id, username, display_name, password_hash, role, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();
  insert.run("student-demo", "student", "林同学", hashPassword("student123"), "student", now);
  insert.run("teacher-demo", "teacher", "王老师", hashPassword("teacher123"), "teacher", now);
  insert.run("admin-demo", "admin", "资料管理员", hashPassword("admin123"), "admin", now);
}

function seedCourseMembers() {
  const courses = db.prepare("SELECT id FROM courses").all();
  const teacher = db.prepare("SELECT id FROM users WHERE username = 'teacher'").get();
  const student = db.prepare("SELECT id FROM users WHERE username = 'student'").get();
  if (!teacher || !student || db.prepare("SELECT COUNT(*) AS count FROM course_members").get().count > 0) return;
  const insert = db.prepare("INSERT OR IGNORE INTO course_members (course_id, user_id, member_role, joined_at) VALUES (?, ?, ?, ?)");
  const now = new Date().toISOString();
  for (const course of courses) {
    insert.run(course.id, teacher.id, "teacher", now);
    if (course.id === "eng101") insert.run(course.id, student.id, "student", now);
  }
}

function getMembership(courseId, userId) {
  return db.prepare("SELECT * FROM course_members WHERE course_id = ? AND user_id = ?").get(courseId, userId) || null;
}

function listUserCourses(userId) {
  return db.prepare(`
    SELECT c.id, c.code, c.name, cm.member_role AS memberRole, cm.joined_at AS joinedAt
    FROM course_members cm JOIN courses c ON c.id = cm.course_id
    WHERE cm.user_id = ? ORDER BY c.rowid
  `).all(userId);
}

function listCourseMembers(courseId) {
  return db.prepare(`
    SELECT u.id, u.username, u.display_name AS displayName, u.role, cm.member_role AS memberRole, cm.joined_at AS joinedAt
    FROM course_members cm JOIN users u ON u.id = cm.user_id
    WHERE cm.course_id = ? ORDER BY cm.joined_at
  `).all(courseId);
}

function addCourseMember(courseId, userId, memberRole = "student") {
  const user = db.prepare("SELECT id, username, display_name AS displayName, role FROM users WHERE id = ?").get(userId);
  const course = db.prepare("SELECT id, name FROM courses WHERE id = ?").get(courseId);
  if (!user || !course || !["student", "teacher"].includes(memberRole)) return null;
  db.prepare("INSERT OR REPLACE INTO course_members (course_id, user_id, member_role, joined_at) VALUES (?, ?, ?, ?)")
    .run(courseId, userId, memberRole, new Date().toISOString());
  return { course, user, memberRole };
}

function removeCourseMember(courseId, userId) {
  return db.prepare("DELETE FROM course_members WHERE course_id = ? AND user_id = ?").run(courseId, userId).changes > 0;
}

function createSession(userId, days = 7) {
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .run(tokenHash, userId, expiresAt, new Date().toISOString());
  return { token, expiresAt };
}

function findUserByCredentials(username, password) {
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!user || !verifyPassword(password, user.password_hash)) return null;
  return { id: user.id, username: user.username, displayName: user.display_name, role: user.role };
}

function findUserByToken(token) {
  if (!token) return null;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const user = db.prepare(`
    SELECT u.id, u.username, u.display_name AS displayName, u.role
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).get(tokenHash, new Date().toISOString());
  return user || null;
}

function deleteSession(token) {
  if (!token) return;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
}

function reviewMaterial(materialId, user, status, note = "") {
  const allowed = new Set(["approved", "rejected", "pending"]);
  if (!allowed.has(status)) return null;
  const material = db.prepare("SELECT id, course_id FROM materials WHERE id = ?").get(materialId);
  if (!material) return null;
  const reviewedAt = status === "pending" ? null : new Date().toISOString();
  db.prepare(`
    UPDATE materials
    SET review_status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?
    WHERE id = ?
  `).run(status, status === "pending" ? null : user.id, reviewedAt, note || null, materialId);
  return db.prepare("SELECT * FROM materials WHERE id = ?").get(materialId);
}

// ================================================================
// FTS5 全文检索（降级 LIKE）
// （沿用上方 initFTS() 初始化；此处补充索引重建与查询接口）
// ================================================================

// 全量重建 FTS 索引（幂等）
function syncFTSIndex() {
  if (!ftsAvailable) return;
  try {
    db.exec("DELETE FROM materials_fts");
    db.exec(`
      INSERT INTO materials_fts(rowid, name, type, source, course_name)
      SELECT m.rowid, m.name, m.type, m.source, c.name
      FROM materials m JOIN courses c ON c.id = m.course_id
    `);
  } catch (e) {
    console.warn("[database] 重建 FTS 索引失败:", e.message);
  }
}

// FTS5 优先，失败时降级 LIKE 查询
function searchMaterials({ q = "", courseId = "", type = "", user = null, limit = 50 }) {
  const where = [];
  const params = [];

  if (user?.role === "student") {
    where.push(`m.course_id IN (SELECT course_id FROM course_members WHERE user_id = ?)`);
    params.push(user.id);
  }
  if (courseId) {
    where.push(`m.course_id = ?`);
    params.push(courseId);
  }
  if (type) {
    where.push(`m.type = ?`);
    params.push(type);
  }

  if (q.trim()) {
    const cleanQ = q.trim().replace(/"/g, '""'); // 转义避免 FTS 语法错误（简单处理）
    try {
      if (ftsAvailable) {
        const rows = db.prepare(`
          SELECT m.id, m.name, m.type, m.source, m.version, m.date,
                 m.file_name AS fileName, m.file_size AS fileSize, m.file_path AS filePath,
                 m.version_chain_id AS versionChainId,
                 m.authority_score AS authorityScore,
                 m.is_authoritative AS isAuthoritative,
                 m.review_status AS reviewStatus,
                 c.id AS courseId, c.name AS courseName,
                 bm25(materials_fts) AS rank
          FROM materials_fts
          JOIN materials m ON m.id = (
            SELECT id FROM materials WHERE materials.rowid = materials_fts.rowid LIMIT 1
          )
          JOIN courses c ON c.id = m.course_id
          WHERE materials_fts MATCH ?
            ${where.length ? `AND ${where.join(" AND ")}` : ""}
          ORDER BY rank
          LIMIT ?
        `).all(cleanQ, ...params, limit);
        return rows.map(r => ({ ...r, rank: undefined }));
      }
    } catch (e) {
      console.warn("[database] FTS 查询失败，降级 LIKE:", e.message);
    }

    const likeQ = `%${cleanQ}%`;
    where.push(`(m.name LIKE ? OR m.type LIKE ? OR m.source LIKE ? OR c.name LIKE ? OR m.version LIKE ?)`);
    params.push(likeQ, likeQ, likeQ, likeQ, likeQ);
  }

  const base = `
    SELECT m.id, m.name, m.type, m.source, m.version, m.date,
           m.file_name AS fileName, m.file_size AS fileSize, m.file_path AS filePath,
           m.version_chain_id AS versionChainId,
           m.authority_score AS authorityScore,
           m.is_authoritative AS isAuthoritative,
           m.review_status AS reviewStatus,
           c.id AS courseId, c.name AS courseName
    FROM materials m JOIN courses c ON c.id = m.course_id
  `;
  const finalWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db.prepare(`${base} ${finalWhere} ORDER BY m.rowid DESC LIMIT ?`).all(...params, limit);
  return rows.map(r => ({ ...r, rank: undefined }));
}

// 单个材料详情 + 版本链历史
function getMaterialDetail(materialId, user) {
  const m = db.prepare("SELECT * FROM materials WHERE id = ?").get(materialId);
  if (!m) return null;

  // 权限：学生访问未加入课程时拒绝
  if (user?.role === "student" && !getMembership(m.course_id, user.id)) return null;

  const versions = db.prepare(`
    SELECT id, version, version_chain_id AS versionChainId, date, status, status_text AS statusText,
           file_name AS fileName, file_size AS fileSize, file_path AS filePath,
           authority_score AS authorityScore, is_authoritative AS isAuthoritative,
           review_status AS reviewStatus, review_note AS reviewNote,
           reviewed_by AS reviewedBy, reviewed_at AS reviewedAt
    FROM materials
    WHERE version_chain_id = ? ORDER BY rowid DESC
  `).all(m.version_chain_id);

  return {
    id: m.id,
    name: m.name,
    type: m.type,
    source: m.source,
    version: m.version,
    date: m.date,
    status: m.status,
    statusText: m.status_text,
    file_name: m.file_name,
    file_size: m.file_size,
    file_path: m.file_path,
    versionChainId: m.version_chain_id,
    authorityScore: m.authority_score,
    authorityBreakdown: m.authority_breakdown ? JSON.parse(m.authority_breakdown) : null,
    isAuthoritative: Boolean(m.is_authoritative),
    reviewStatus: m.review_status,
    reviewNote: m.review_note,
    reviewedBy: m.reviewed_by,
    reviewedAt: m.reviewed_at,
    versions
  };
}

// 记录一次版本变更（发布新版本或数据同步时调用）
function recordMaterialVersion(material, userId, changeNote) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO material_versions (id, chain_id, material_id, version_num, file_hash, created_by, change_note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    material.version_chain_id || `${material.name}:${material.type}`,
    material.id,
    parseInt(String(material.version || "1").replace(/\D/g, ""), 10) || 1,
    material.file_hash || null,
    userId,
    changeNote || null,
    now
  );
}

// ================================================================
// 权限与数据一致性辅助
// ================================================================
function isTeacherOrAdmin(user) {
  return Boolean(user && (user.role === "teacher" || user.role === "admin"));
}

function canAccessCourse(user, courseId) {
  if (!user) return false;
  if (user.role === "admin") return true;
  if (user.role === "teacher") return true;
  return Boolean(getMembership(courseId, user.id));
}

initFTS();

seedUsers();
seedCourseMembers();

module.exports = {
  db, readData, writeData, createSession, findUserByCredentials,
  findUserByToken, deleteSession, reviewMaterial, getMembership,
  listUserCourses, listCourseMembers, addCourseMember, removeCourseMember,
  searchMaterials, getMaterialDetail, recordMaterialVersion,
  isTeacherOrAdmin, canAccessCourse, syncFTSIndex
};
