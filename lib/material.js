"use strict";

/**
 * 资料对象工厂（server.js 与 sync-engine.js 共用，避免两套实现漂移）
 */

const crypto = require("node:crypto");

const OFFICIAL_SOURCES = new Set(["Canvas", "知途好课"]);

function todayString() {
  const now = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}.${p(now.getMonth() + 1)}.${p(now.getDate())}`;
}

function normalizeMaterial(input = {}) {
  const source = String(input.source || "班级群");
  const official = OFFICIAL_SOURCES.has(source);
  return {
    id: input.id || crypto.randomUUID(),
    name: String(input.name || "").trim(),
    type: String(input.type || "课件"),
    source,
    version: input.version || "V1.0",
    date: input.date || todayString(),
    status: input.status || (official ? "official" : "student"),
    statusText: input.statusText || (official ? "最新权威版" : "学生整理"),
    icon: input.icon || "▤",
    fileHash: input.fileHash || null,
    fileName: input.fileName || null,
    fileSize: input.fileSize ?? null,
    filePath: input.filePath || null,
    versionChainId: input.versionChainId || crypto.randomUUID(),
    extractedText: input.extractedText ?? null,
    similarity: input.similarity ?? null,
    versionReason: input.versionReason ?? null,
    authorityScore: input.authorityScore ?? 0,
    authorityBreakdown: input.authorityBreakdown ?? null,
    isAuthoritative: input.isAuthoritative ?? false,
    reviewStatus: input.reviewStatus || "pending",
    reviewedBy: input.reviewedBy || null,
    reviewedAt: input.reviewedAt || null,
    reviewNote: input.reviewNote || null,
  };
}

module.exports = { normalizeMaterial, OFFICIAL_SOURCES };
