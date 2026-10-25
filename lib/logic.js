"use strict";

/**
 * lib/logic.js —— 纯逻辑函数模块（无副作用，可独立单元测试）
 *
 * 集中了可信度计算、版本号生成、文本指纹等核心算法，
 * 供 server.js 与单元测试共同引用。
 */

const crypto = require("node:crypto");

/** 各来源的类型权重（与 server.js 中 sourceAuthority 保持一致） */
const SOURCE_WEIGHT = {
  Canvas: 1,
  "知途好课": 0.92,
  "教师上传": 0.95,
  "班级群": 0.58,
  网盘: 0.48,
  转发: 0.4,
};

/**
 * 五因子加权可信度计算
 * 权重：来源×0.35 + 时间×0.20 + 变更×0.15 + 审核×0.20 + 完整度×0.10
 *
 * @param {object} material 材料对象（含 source / date / status / reviewStatus / fileSize / content 等）
 * @param {Array}  chain 同一版本链上的所有版本（用于计算变更度与权威）
 * @returns {{score:number, parts:object}} 分数与各因子分解
 */
function calculateScore(material, chain = []) {
  const source = SOURCE_WEIGHT[material.source] ?? 0.35;

  const newest = Math.max(
    ...chain.map((item) => parseDate(item.date).getTime()),
    Date.now()
  );
  const ageDays = Math.max(0, (newest - parseDate(material.date).getTime()) / 86400000);
  const freshness = Math.exp(-ageDays / 30);

  const similarity = Number(material.similarity ?? 0);
  const change =
    material.content != null || material.extractedText != null
      ? Math.min(1, Math.max(0.1, 1 - similarity))
      : 0.55;

  const review = material.reviewStatus === "approved" ? 1 : 0;

  const rawComplete = clamp01(material.completeness);
  const completeness =
    material.completeness != null
      ? rawComplete
      : material.fileSize
      ? Math.min(1, Math.max(0.2, material.fileSize / (100 * 1024)))
      : 0.35;

  const parts = {
    source: { score: source, weight: 0.35 },
    freshness: { score: freshness, weight: 0.2 },
    change: { score: change, weight: 0.15 },
    review: { score: review, weight: 0.2 },
    completeness: { score: completeness, weight: 0.1 },
  };

  const score = Object.values(parts).reduce(
    (sum, p) => sum + p.score * p.weight,
    0
  );

  return {
    score: Number(score.toFixed(3)),
    parts,
    breakdown: Object.entries(parts)
      .map(([key, p]) => ({
        label: key,
        score: Number((p.score * p.weight).toFixed(3)),
        weight: p.weight,
        detail: p.score,
      }))
      .sort((a, b) => b.score - a.score),
  };
}

/** 解析 "2026.10.15" 或 ISO 字符串为 Date，解析失败返回 epoch */
function parseDate(value) {
  const parsed = new Date(String(value || "").replace(/\./g, "-"));
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

/**
 * 给定版本列表生成下一个版本号（在列表尾部自动 +1）
 * @param {Array<string>} versions 如 ["V1.0","V2.0"]
 */
function nextVersion(versions) {
  const nums = versions
    .map((v) => Number.parseInt(String(v).replace("V", ""), 10))
    .filter((n) => !Number.isNaN(n));
  return `V${Math.max(0, ...nums) + 1}.0`;
}

/** 规范化文本：小写 + 压缩空白 */
function normalizeText(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 生成内容指纹：对规范化文本做 SHA-256 摘要前 12 位
 */
function textFingerprint(text) {
  return crypto
    .createHash("sha256")
    .update(normalizeText(text))
    .digest("hex")
    .slice(0, 12);
}

/**
 * 计算两段文本的词集相似度（Jaccard 系数）
 */
function textSimilarity(left, right) {
  const a = new Set(normalizeText(left).toLowerCase().split(/\s+/).filter(Boolean));
  const b = new Set(normalizeText(right).toLowerCase().split(/\s+/).filter(Boolean));
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  return overlap / new Set([...a, ...b]).size;
}

/** 将值裁剪到 [0,1] */
function clamp01(x) {
  const n = Number(x);
  if (n == null || Number.isNaN(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

/**
 * 判断用户是否可查看某课程。
 * 管理员 / 教师可查看全部；学生需在 memberships 中。
 */
function canViewCourse(user, courseId, isMember) {
  if (!user) return false;
  if (user.role === "admin") return true;
  if (user.role === "teacher") return true;
  return Boolean(isMember);
}

/**
 * 资源归属判断：管理员可删除任何人的材料；教师可操作自己课程；
 * 学生只能操作自己的材料。
 */
function canManageMaterial(user, material, courseId, courseRole) {
  if (!user) return false;
  if (user.role === "admin") return true;
  if (user.role === "teacher") return courseRole === "teacher";
  return Boolean(material.ownerId && material.ownerId === user.id);
}

module.exports = {
  SOURCE_WEIGHT,
  calculateScore,
  parseDate,
  nextVersion,
  normalizeText,
  textFingerprint,
  textSimilarity,
  clamp01,
  canViewCourse,
  canManageMaterial,
};
