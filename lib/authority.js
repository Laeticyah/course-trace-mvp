"use strict";

/**
 * 权威度评分（五因子）+ 版本链权威标记。
 * server.js 与 sync-engine.js 共用，保证「同步写入」和「接口读取」口径一致。
 */

const { SOURCE_WEIGHT: SOURCE_AUTHORITY } = require("./sources");

function parseDate(value) {
  const parsed = new Date(String(value || "").replaceAll(".", "-"));
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

function clamp01(x) {
  if (x == null || Number.isNaN(Number(x))) return 0.5;
  return Math.min(1, Math.max(0, Number(x)));
}

function calculateAuthority(material, chain) {
  // —— 五因子可信度加权（来源×35% + 时间×20% + 变更×15% + 审核×20% + 完整度×10%）
  const sourceScore = SOURCE_AUTHORITY[material.source] ?? 0.35;
  const newest = Math.max(...chain.map((item) => parseDate(item.date).getTime()), Date.now());
  const ageDays = Math.max(0, (newest - parseDate(material.date).getTime()) / 86400000);
  const freshnessScore = Math.exp(-ageDays / 30);
  const similarity = Number(material.similarity ?? 0);
  const changeScore = material.extractedText
    ? Math.min(1, Math.max(0.1, 1 - similarity))
    : 0.55;

  // 教师审核因子：approved → 1，否则 0（默认 pending=0 → 不加分也不扣分）
  const reviewScore = material.reviewStatus === "approved" ? 1 : 0;
  // 内容完整度因子：显式提供则用，否则按文件大小粗略估计（≥100KB→1）
  const rawComplete = clamp01(material.completeness);
  const completenessScore = material.completeness != null
    ? rawComplete
    : material.fileSize ? Math.min(1, Math.max(0.2, material.fileSize / (100 * 1024))) : 0.35;

  const parts = {
    source: { score: sourceScore, weight: 0.35, label: "来源权威度", detail: `来自 ${material.source}，可信度 ${Math.round(sourceScore * 100)}%` },
    freshness: { score: freshnessScore, weight: 0.20, label: "时间新度", detail: ageDays < 1 ? "今天更新" : `${Math.round(ageDays)} 天前更新` },
    change: { score: changeScore, weight: 0.15, label: "内容变更度", detail: `与上一版本相似度 ${Math.round(similarity * 100)}%` },
    review: { score: reviewScore, weight: 0.20, label: "教师审核", detail: reviewScore ? "已确认，+20%" : "待确认，无加分" },
    completeness: { score: completenessScore, weight: 0.10, label: "内容完整度", detail: material.fileSize ? `文件 ${(material.fileSize / 1024).toFixed(0)}KB，约 ${Math.round(completenessScore * 100)}% 完整` : "未提供文件，估测 35%" },
  };

  const score = Object.values(parts).reduce((sum, part) => sum + part.score * part.weight, 0);

  return {
    score: Number(score.toFixed(3)),
    parts,
    breakdown: Object.values(parts)
      .map((part) => ({ label: part.label, value: Number((part.score * part.weight).toFixed(3)), detail: part.detail }))
      .sort((a, b) => b.value - a.value),
  };
}

function applyAuthority(courses) {
  for (const course of courses) {
    const chains = new Map();
    for (const material of course.materials) {
      const chainId = material.versionChainId || `${material.name}:${material.type}`;
      if (!chains.has(chainId)) chains.set(chainId, []);
      chains.get(chainId).push(material);
    }
    for (const chain of chains.values()) {
      const scored = chain.map((material) => ({ material, breakdown: calculateAuthority(material, chain) }));
      // 已归档版本不参与“当前权威版”评选
      const active = scored.filter((item) => item.material.status !== "archived");
      const approved = active
        .filter((item) => item.material.reviewStatus === "approved")
        .sort((a, b) => parseDate(b.material.date) - parseDate(a.material.date))[0];
      const authoritative = approved || active.reduce((best, item) =>
        !best || item.breakdown.score > best.breakdown.score ? item : best, null);
      for (const { material, breakdown } of scored) {
        material.authorityScore = breakdown.score;
        material.authorityBreakdown = breakdown;
        if (material.status === "archived") {
          material.isAuthoritative = false;
          material.statusText = "已归档";
          continue;
        }
        material.isAuthoritative = Boolean(authoritative && material.id === authoritative.material.id);
        if (material.status === "official") {
          material.statusText = material.isAuthoritative ? "最新权威版" : "官方历史版";
        } else {
          material.statusText = "学生整理";
        }
      }
    }
  }
  return courses;
}

module.exports = { SOURCE_AUTHORITY, calculateAuthority, applyAuthority, parseDate };
