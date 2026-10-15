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
    member_role TEXT NOT NULL CHECK (member_role IN ('student', 'teacher')),
    joined_at TEXT NOT NULL,
    PRIMARY KEY (course_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_course_members_user ON course_members(user_id);
`);

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

seedUsers();
seedCourseMembers();

module.exports = {
  db, readData, writeData, createSession, findUserByCredentials,
  findUserByToken, deleteSession, reviewMaterial, getMembership,
  listUserCourses, listCourseMembers, addCourseMember, removeCourseMember
};
