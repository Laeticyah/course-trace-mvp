/**
 * mock-data.js — 课脉 · 内置演示数据源
 *
 * 设计目的：
 *   将演示数据从业务逻辑（app.js）中独立出来，供开发模式（DEV_MODE）使用。
 *   生产环境中 API 可用时，此文件中的数据不会被使用；只有 API 调用失败且
 *   明确允许 mock 回退时才会用到。
 *
 * 使用方式：
 *   - 开发环境：允许 mock 回退，便于离线演示
 *   - 生产环境：禁止 mock 回退，API 失败时显示明确错误提示 + 重试按钮
 */
(function (global) {
  "use strict";

  // ─── 内置演示数据 ─────────────────────────────────────────────
  const mockCourses = [
    {
      id: "eng101",
      code: "ENG 101",
      name: "工程学导论",
      desc: "Engineering Fundamentals",
      color: "blue",
      count: 18,
      progress: 72,
      official: 4,
      updates: "今日更新",
      materials: [
        {
          id: "m-eng101-1",
          name: "第 3 章｜需求分析与问题定位",
          type: "课件",
          source: "Canvas",
          version: "V3.0",
          date: "2026.10.15",
          status: "official",
          statusText: "最新权威版",
          icon: "▤",
          filePath: "uploads/eng101/需求分析-第三章.pdf",
          fileName: "需求分析-第三章.pdf",
        },
        {
          id: "m-eng101-2",
          name: "项目建议书评分标准",
          type: "作业要求",
          source: "Canvas",
          version: "V2.1",
          date: "2026.10.12",
          status: "official",
          statusText: "官方资料",
          icon: "▣",
          filePath: "uploads/eng101/项目建议书评分标准.pdf",
          fileName: "项目建议书评分标准.pdf",
        },
        {
          id: "m-eng101-3",
          name: "答辩重点与个人分工整理",
          type: "复习笔记",
          source: "班级群",
          version: "V1.0",
          date: "2026.09.28",
          status: "student",
          statusText: "学生整理",
          icon: "✎",
          filePath: "uploads/eng101/答辩重点与个人分工整理.pdf",
          fileName: "答辩重点与个人分工整理.pdf",
        },
      ],
    },
    {
      id: "math101",
      code: "MATH 101",
      name: "高等数学 I",
      desc: "Advanced Mathematics",
      color: "orange",
      count: 24,
      progress: 54,
      official: 7,
      updates: "2 天前",
      materials: [
        {
          id: "m-math101-1",
          name: "第 5 章｜定积分应用",
          type: "课件",
          source: "知途好课",
          version: "V2.0",
          date: "2026.10.13",
          status: "official",
          statusText: "最新权威版",
          icon: "▤",
        },
        {
          id: "m-math101-2",
          name: "期中复习范围说明",
          type: "作业要求",
          source: "Canvas",
          version: "V1.0",
          date: "2026.10.01",
          status: "official",
          statusText: "官方资料",
          icon: "▣",
        },
        {
          id: "m-math101-3",
          name: "极限与连续性错题整理",
          type: "复习笔记",
          source: "网盘",
          version: "V1.2",
          date: "2026.09.28",
          status: "student",
          statusText: "学生整理",
          icon: "✎",
        },
      ],
    },
    {
      id: "ai101",
      code: "AI 101",
      name: "人工智能导论",
      desc: "Introduction to AI",
      color: "green",
      count: 31,
      progress: 81,
      official: 9,
      updates: "5 天前",
      materials: [
        {
          id: "m-ai101-1",
          name: "第 2 章｜机器学习概览",
          type: "课件",
          source: "Canvas",
          version: "V4.0",
          date: "2026.10.10",
          status: "official",
          statusText: "最新权威版",
          icon: "▤",
        },
        {
          id: "m-ai101-2",
          name: "Python 环境配置避坑指南",
          type: "复习笔记",
          source: "班级群",
          version: "V1.0",
          date: "2026.09.22",
          status: "student",
          statusText: "学生整理",
          icon: "✎",
        },
      ],
    },
  ];

  const mockAlerts = [
    {
      title: "工程学导论 · 第 3 章课件已更新",
      desc: "检测到内容变更：新增『需求优先级』小节。V3.0 已成为当前权威版本。",
      time: "今天 09:42",
      course: "工程学导论",
      unread: true,
    },
    {
      title: "工程学导论 · 项目建议书评分标准",
      desc: "老师更新了提交格式说明，旧版本已自动归档。",
      time: "昨天 16:20",
      course: "工程学导论",
      unread: true,
    },
    {
      title: "高等数学 I · 期中复习范围",
      desc: "已确认当前版本来自 Canvas，暂无内容变更。",
      time: "10 月 13 日",
      course: "高等数学 I",
      unread: true,
    },
    {
      title: "人工智能导论 · 机器学习概览",
      desc: "版本 V4.0 已同步，新增 2 个示例。",
      time: "10 月 10 日",
      course: "人工智能导论",
      unread: false,
    },
  ];

  // 深拷贝快照，避免调用方直接修改内置数据
  function getMockCourses() {
    return JSON.parse(JSON.stringify(mockCourses));
  }
  function getMockAlerts() {
    return JSON.parse(JSON.stringify(mockAlerts));
  }

  // ─── 暴露接口 ─────────────────────────────────────────────────
  global.MockData = {
    getCourses: getMockCourses,
    getAlerts: getMockAlerts,
  };
})(window || globalThis);
