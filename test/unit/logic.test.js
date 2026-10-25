"use strict";

/**
 * 单元测试 · lib/logic.js 纯函数
 * 运行方式: node --test test/unit/
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
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
} = require("../../lib/logic.js");

describe("权威度计算 calculateScore", () => {
  it("官方来源且全新应有较高分", () => {
    const chain = [
      { date: "2026.10.15", source: "Canvas", reviewStatus: "approved", fileSize: 250000, content: "x" },
    ];
    const r = calculateScore(chain[0], chain);
    assert.ok(r.score > 0.7, `得分应较高，实际 ${r.score}`);
  });

  it("待审核材料分数低于已审核", () => {
    const approved = calculateScore(
      { source: "Canvas", date: "2026.10.15", reviewStatus: "approved", fileSize: 250000 },
      [{ source: "Canvas", date: "2026.10.15", reviewStatus: "approved", fileSize: 250000 }]
    );
    const pending = calculateScore(
      { source: "Canvas", date: "2026.10.15", reviewStatus: "pending", fileSize: 250000 },
      [{ source: "Canvas", date: "2026.10.15", reviewStatus: "pending", fileSize: 250000 }]
    );
    assert.ok(approved.score > pending.score);
  });

  it("返回 parts 包含五个因子", () => {
    const r = calculateScore({ source: "班级群", date: "2026.09.21", fileSize: 50000 });
    const keys = Object.keys(r.parts);
    assert.deepEqual(keys, ["source", "freshness", "change", "review", "completeness"]);
  });
});

describe("版本号生成 nextVersion", () => {
  it("空列表返回 V1.0", () => {
    assert.equal(nextVersion([]), "V1.0");
  });

  it("已有 V2.0 生成 V3.0", () => {
    assert.equal(nextVersion(["V2.0", "V1.2"]), "V3.0");
  });

  it("忽略非法版本号", () => {
    assert.equal(nextVersion(["abc", "V5.0"]), "V6.0");
  });
});

describe("文本规范化 normalizeText", () => {
  it("去掉标签并压缩空白", () => {
    const out = normalizeText("  <p>   Hello ,  World!  </p> ");
    assert.equal(out, "Hello , World!");
  });
});

describe("内容指纹 textFingerprint", () => {
  it("指纹是 12 位十六进制", () => {
    const fp = textFingerprint("第三章 需求分析课件 2026-10-15");
    assert.match(fp, /^[0-9a-f]{12}$/);
  });

  it("相同输入有相同指纹", () => {
    assert.equal(textFingerprint("abc"), textFingerprint("abc"));
  });
});

describe("相似度计算 textSimilarity", () => {
  it("完全相同 = 1", () => {
    assert.equal(textSimilarity("需求分析 课件", "需求分析 课件"), 1);
  });

  it("完全无关 = 0", () => {
    assert.equal(textSimilarity("高等数学 微积分", "计算机 网络"), 0);
  });

  it("部分重叠介于 0 和 1 之间", () => {
    const s = textSimilarity("需求分析 软件工程", "需求分析 产品经理");
    assert.ok(s > 0 && s < 1, `应介于 0-1，实际 ${s}`);
  });
});

describe("权限判断", () => {
  it("未登录用户无法查看", () => {
    assert.equal(canViewCourse(null, "eng101", false), false);
  });

  it("管理员可查看任意课程", () => {
    const admin = { role: "admin" };
    assert.equal(canViewCourse(admin, "anycourse", false), true);
  });

  it("教师可查看任意课程", () => {
    const teacher = { role: "teacher" };
    assert.equal(canViewCourse(teacher, "anycourse", false), true);
  });

  it("学生需有成员身份", () => {
    const student = { role: "student" };
    assert.equal(canViewCourse(student, "eng101", false), false);
    assert.equal(canViewCourse(student, "eng101", true), true);
  });
});

describe("资源管理权限 canManageMaterial", () => {
  it("管理员可管理任何材料", () => {
    const admin = { role: "admin", id: "u1" };
    assert.equal(canManageMaterial(admin, { ownerId: "u999" }, "course", "teacher"), true);
  });

  it("教师可管理自己课程的材料", () => {
    const teacher = { role: "teacher", id: "u2" };
    assert.equal(canManageMaterial(teacher, { ownerId: "u999" }, "course", "teacher"), true);
    assert.equal(canManageMaterial(teacher, { ownerId: "u999" }, "course", "student"), false);
  });

  it("学生只能管理自己的材料", () => {
    const student = { role: "student", id: "u3" };
    assert.equal(canManageMaterial(student, { ownerId: "u3" }, "course", "student"), true);
    assert.equal(canManageMaterial(student, { ownerId: "u4" }, "course", "student"), false);
  });
});
