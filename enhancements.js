/* =========================================================================
 * 课脉 · 前端增强层（阶段 1：稳定原型）
 *
 * 本文件叠加在 app.js 之上（脚本顺序在 app.js 之后），在不动原型核心
 * 逻辑的前提下，为 MVP 补充「稳定原型」所需的能力：
 *
 *   1. 权限与界面授权：管理后台仅对 manager 角色开放，其余角色自动隐藏入口
 *   2. 课程详情页：面向单门课的完整视图（筛选 + 排序 + 分页）
 *   3. 资料详情页：可信度分解 + 来源信息 + 版本时间线 + 生命周期操作
 *   4. 管理后台：全库资料生命周期（归档 / 恢复 / 删除）与审核总览
 *   5. 状态渲染：加载中 / 空数据 / 出错 的统一提示与「重试」按钮
 *
 * 依赖的全局符号（来自于 app.js 的顶层作用域）：
 *   - courses / alerts    : 全局数据
 *   - currentUser         : 当前登录用户（含 .role）
 *   - authHeaders(), showToast(), switchView(v)
 */
(function () {
  "use strict";

  var $  = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

  /* ---------------------------------------------------------------- */
  /* 工具函数                                                          */
  /* ---------------------------------------------------------------- */
  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function fmtDate(d) {
    if (!d) return "—";
    var t = new Date(String(d).replace(/\./g, "-"));
    return isNaN(t.getTime()) ? String(d) : t.toLocaleDateString("zh-CN");
  }

  function fmtSize(bytes) {
    if (!bytes) return "—";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
  }

  function sourceLabel(s) {
    return ({ Canvas: "课程平台", 知途好课: "知途好课", 班级群: "班级群", 网盘: "网盘" })[s] || s || "未知来源";
  }

  function canManage() {
    return Boolean(typeof currentUser !== "undefined" && currentUser &&
      ["admin", "teacher"].includes(currentUser.role));
  }

  /* ---------------------------------------------------------------- */
  /* 状态渲染：加载中 / 空数据 / 错误                                   */
  /* ---------------------------------------------------------------- */
  function setViewState(container, kind, message) {
    if (!container) return;
    var icons = { loading: "⟳", empty: "◌", error: "!" };
    container.innerHTML =
      '<div class="state-box ' + kind + '"><span class="state-icon">' +
      (icons[kind] || "i") + "</span><p>" + esc(message || "") + "</p></div>";
    container.hidden = false;
  }

  /* ---------------------------------------------------------------- */
  /* 资料查找：在全局课程数据中定位某个资料                              */
  /* ---------------------------------------------------------------- */
  function findMaterial(materialId) {
    var all = (typeof courses !== "undefined" && courses) || [];
    for (var i = 0; i < all.length; i++) {
      var c = all[i];
      var found = (c.materials || []).filter(function (m) {
        return String(m.id) === String(materialId) || String(m.name) === String(materialId);
      })[0];
      if (found) return { course: c, material: found };
    }
    return null;
  }

  /* ---------------------------------------------------------------- */
  /* 课程详情页                                                         */
  /* ---------------------------------------------------------------- */
  function renderCourseDetail(courseId) {
    var view = $("#course-detail-view");
    if (!view) return;

    var course = ((typeof courses !== "undefined" && courses) || [])
      .filter(function (c) { return String(c.id) === String(courseId); })[0];

    if (!course) {
      setViewState(view, "empty", "未找到该课程，请返回课程列表重试。");
      return;
    }
    if (typeof window.App === "object") window.App.currentCourseId = courseId;

    var materials = (course.materials || []).slice();
    var total = materials.length;
    var official = materials.filter(function (m) { return m.status === "official"; }).length;
    var student  = materials.filter(function (m) { return m.status === "student"; }).length;
    var archived = materials.filter(function (m) { return m.status === "archived"; }).length;

    var statCards = [
      ["资料总数", total],
      ["官方资料", official],
      ["学生整理", student],
      ["已归档", archived],
    ].map(function (item) {
      return '<div class="stat-card"><strong>' + item[1] + "</strong><small>" + item[0] + "</small></div>";
    }).join("");

    var sort = ($("#course-sort") || {}).value || "date_desc";
    materials.sort(function (a, b) {
      if (sort === "date_asc") return (a.date || "").localeCompare(b.date || "");
      if (sort === "name") return (a.name || "").localeCompare(b.name || "", "zh-CN");
      if (sort === "authority") return (b.authorityScore || 0) - (a.authorityScore || 0);
      return (b.date || "").localeCompare(a.date || "");
    });

    var filter = ($("#course-filter") || {}).value || "all";
    var filtered = materials.filter(function (m) {
      if (filter === "official") return m.status === "official";
      if (filter === "student") return m.status === "student";
      if (filter === "archived") return m.status === "archived";
      return true;
    });

    var PAGE_SIZE = 5;
    var pageInput = $("#course-page");
    var totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    var page = Math.min(Math.max(parseInt((pageInput || {}).value || "1", 10) || 1, 1), totalPages);
    if (pageInput) pageInput.value = String(page);
    var pageItems = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

    var rows = pageItems.map(function (m) {
      var badgeMarkup = m.status === "archived"
        ? '<span class="tag badge-gray">已归档</span>'
        : m.reviewStatus === "approved" || m.isAuthoritative
          ? '<span class="tag badge-green">已审核 · 权威</span>'
          : '<span class="tag badge-amber">待审核</span>';
      return '<div class="material-row detail-row" data-open-material="' + esc(m.id || m.name) + '" title="查看资料详情" style="cursor:pointer">'
        + '<span class="material-icon">' + esc(m.icon || "▤") + "</span>"
        + '<div class="row-main"><strong>' + esc(m.name) + "</strong>"
        + "<small>" + esc(m.type || "资料") + (m.version ? " · " + esc(m.version) : "") + " · " + fmtDate(m.date) + "</small></div>"
        + '<div class="row-meta">' + badgeMarkup
        + (m.authorityScore != null ? ' <em class="score-mini">' + Math.round(m.authorityScore * 100) + "%</em>" : "")
        + '</div><span class="row-chevron">›</span></div>';
    }).join("");

    var pageNav = totalPages > 1
      ? '<div class="pagination">'
        + '<button class="page-btn" data-page-nav="' + Math.max(1, page - 1) + '" ' + (page <= 1 ? "disabled" : "") + '>‹ 上一页</button>'
        + '<span class="page-info">第 <b>' + page + "</b> / " + totalPages + " 页</span>"
        + '<button class="page-btn" data-page-nav="' + Math.min(totalPages, page + 1) + '" ' + (page >= totalPages ? "disabled" : "") + '>下一页 ›</button>'
        + "</div>"
      : "";

    view.innerHTML = '<div class="page-head"><div><button class="back-link" data-goto="courses">← 返回我的课程</button>'
      + "<h1>" + esc(course.name) + '</h1><p class="page-subhead">' + esc(course.desc || "") + " · 代码 " + esc(course.code || "") + "</p></div>"
      + '<button class="primary-button" data-sync-course="' + esc(course.id) + '">⟳ 同步 Canvas</button></div>'
      + '<div class="quick-stats">' + statCards + "</div>"
      + '<div class="toolbar"><div class="filter-group">'
      + '<select id="course-filter"><option value="all">全部</option><option value="official">官方资料</option><option value="student">学生整理</option><option value="archived">已归档</option></select>'
      + '<select id="course-sort"><option value="date_desc">最近更新</option><option value="date_asc">最早更新</option><option value="name">名称</option><option value="authority">权威度</option></select>'
      + '</div><span class="count-badge">共 ' + filtered.length + " 份资料</span></div>"
      + '<div id="course-detail-content" class="material-group-detail">'
      + (rows || '<div class="empty-inline">当前筛选下没有资料。</div>')
      + "</div>" + pageNav;

    if (typeof switchView === "function") switchView("courses");
  }

  /* ---------------------------------------------------------------- */
  /* 资料详情页：来源信息 / 可信度 / 版本时间线                          */
  /* ---------------------------------------------------------------- */
  function renderMaterialDetail(materialId) {
    var found = findMaterial(materialId);
    var view = $("#material-detail-view");
    if (!view) return;

    if (!found) {
      setViewState(view, "error", "该资料不存在，可能已被作者删除。");
      return;
    }
    var c = found.course;
    var m = found.material;

    var versions = (m.versions && m.versions.length) ? m.versions : [m];
    var score = m.authorityScore != null ? Math.round(m.authorityScore * 100) : 0;
    var bd = m.authorityBreakdown || m.breakdown || {};
    var bars = [
      ["来源权威度", bd.source],
      ["时间新度", bd.freshness],
      ["内容变更度", bd.change],
    ].map(function (item) {
      var pct = Math.round((item[1] == null ? 0 : item[1]) * 100);
      return '<div class="master-bar"><span>' + item[0] + '</span><div class="master-bar-track"><span style="width:' + pct + '%"></span></div><em>' + pct + "%</em></div>";
    }).join("");

    var timeline = versions.map(function (v, i) {
      return '<div class="timeline-item ' + (i === 0 ? "current" : "old") + '">' +
        "<time>" + fmtDate(v.date || v.createdAt) + "</time>" +
        "<strong>" + esc(v.version || "V1.0") + "</strong>" +
        "<span>" + esc(v.name || m.name) + "</span>" +
        (v.reviewStatus === "approved" ? '<em class="tag badge-green">已审</em>' : "") +
        (v.status === "archived" ? '<em class="tag badge-gray">已归档</em>' : "") +
        "</div>";
    }).join("");

    view.innerHTML = '<div class="page-head"><div><button class="back-link" data-goto="courses">← 返回课程</button>'
      + "<h1>" + esc(m.name) + "</h1>"
      + "<p>" + esc(c.name) + " · " + esc(m.type || "资料") + "</p></div></div>"

      + '<div class="material-layout">'
      + '<div class="material-main">'
      + '<div class="master-card"><h3>资料信息</h3><dl class="kv">'
      + "<dt>来源</dt><dd>" + esc(sourceLabel(m.source)) + "</dd>"
      + "<dt>版本</dt><dd>" + esc(m.version || "V1.0") + "</dd>"
      + "<dt>日期</dt><dd>" + fmtDate(m.date) + "</dd>"
      + "<dt>收录时间</dt><dd>" + fmtDate(m.createdAt || m.updatedAt) + "</dd>"
      + "</dl></div>"

      + '<div class="master-card">'
      + "<h3>版本时间线</h3>"
      + (timeline || '<div class="empty-inline">暂无可回溯版本。</div>')
      + "</div>"
      + "</div>"

      + "<aside class='material-aside'>"
      + '<div class="master-card"><h3>权威评分</h3>'
      + '<div class="score-ring" style="--pct:' + score + '%"><strong>' + score + "</strong></div>"
      + '<div class="master-bars">' + bars + "</div></div>"

      + (m.filePath
        ? '<div class="master-card"><h3>文件</h3><a class="primary-button full-width" href="/api/courses/' + esc(c.id) + '/files/' + encodeURIComponent(m.fileName || m.name) + '" download>⇢ 下载文件</a></div>'
        : '<div class="master-card"><h3>文件</h3><p class="muted-text">未附带本地文件。</p></div>')

      + (canManage() ? '<div class="master-card"><h3>生命周期</h3>' +
        (m.status === "archived"
          ? '<button class="outline-button full-width" data-lifecycle-action="restore" data-id="' + esc(m.id) + '">恢复资料</button>'
          : '<button class="outline-button full-width" data-lifecycle-action="archive" data-id="' + esc(m.id) + '">归档资料</button>') +
        '<br><button class="danger-button full-width" data-lifecycle-action="delete" data-id="' + esc(m.id) + '">删除资料</button></div>'
        : "")
      + "</aside>"
      + "</div>";

    if (typeof switchView === "function") switchView("material-detail");
  }

  /* ---------------------------------------------------------------- */
  /* 管理后台                                                           */
  /* ---------------------------------------------------------------- */
  function renderAdmin() {
    var view = $("#admin-view");
    if (!view) return;
    if (!canManage()) {
      setState(view, "empty", "当前账号没有管理后台权限。");
      return;
    }
    var all = ((typeof courses !== "undefined" && courses) || []).flatMap(function (c) {
      return (c.materials || []).map(function (m) {
        return Object.assign({}, m, { courseName: c.name, courseCode: c.code });
      });
    });
    var total = all.length;
    var official = all.filter(function (m) { return m.status === "official"; }).length;
    var archived = all.filter(function (m) { return m.status === "archived"; }).length;
    var review = all.filter(function (m) { return m.reviewStatus === "pending" || m.reviewStatus === "underReview"; }).length;

    var rows = all.map(function (m) {
      var label = m.status === "archived" ? "已归档"
        : m.status === "official" ? "官方资料"
        : m.status === "student" ? "学生整理" : m.status || "—";
      var badge = m.status === "archived" ? "badge-gray"
        : m.status === "official" ? "badge-green" : "badge-amber";
      return "<tr>"
        + "<td><strong>" + esc(m.name) + "</strong><br><small class='muted-text'>" + esc(m.version || "") + "</small></td>"
        + "<td>" + esc(m.courseName) + "</td>"
        + "<td><span class='tag " + badge + "'>" + esc(label) + "</span></td>"
        + "<td>" + (m.authorityScore != null ? Math.round(m.authorityScore * 100) + "%" : "—") + "</td>"
        + "<td><button class='btn-sm' data-open-material='" + esc(m.id || m.name) + "'>查看</button></td>"
        + "</tr>";
    }).join("");

    view.innerHTML = "<div class='page-head'><div><span class='tiny-label'>ADMIN CONSOLE</span><h1>管理后台</h1>"
      + "<p>全库资料生命周期与审核状态总览。</p></div>"
      + "<button class='primary-button' data-admin-export>导出 JSON</button></div>"

      + "<div class='quick-stats'>"
      + '<div class="stat-card"><strong>' + total + "</strong><small>资料总数</small></div>"
      + '<div class="stat-card"><strong>' + official + "</strong><small>官方资料</small></div>"
      + '<div class="stat-card"><strong>' + review + "</strong><small>待审核</small></div>"
      + '<div class="stat-card"><strong>' + archived + "</strong><small>已归档</small></div>"
      + "</div>"

      + "<div class='admin-card'><div class='admin-card-head'><h3>全库资料清单</h3><span class='count-badge'>共 " + total + " 份</span></div>"
      + "<div class='table-wrap'><table class='admin-table'><thead><tr>"
      + "<th>资料名称</th><th>课程</th><th>状态</th><th>权威度</th><th>操作</th></tr></thead>"
      + "<tbody>" + (rows || "<tr><td colspan='5' class='empty-state'>暂无资料</td></tr>") + "</tbody></table></div></div>";

    var exportBtn = view.querySelector("[data-admin-export]");
    if (exportBtn) exportBtn.addEventListener("click", function () {
      var copy = all.map(function (m) { return { 名称: m.name, 类型: m.type, 来源: m.source, 课程: m.courseName, 版本: m.version, 日期: m.date, 状态: m.statusText || m.status, 权威度: m.authorityScore }; });
      var blob = new Blob([JSON.stringify(copy, null, 2)], { type: "text/plain;charset=utf-8" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "课脉冲全库.json";
      a.click();
      if (typeof showToast === "function") showToast("已导出 JSON ✓");
    });
    view.querySelectorAll("[data-open-material]").forEach(function (b) {
      b.addEventListener("click", function () {
        renderMaterialDetail(b.getAttribute("data-open-material"));
      });
    });
  }

  /* ---------------------------------------------------------------- */
  /* 事件路由：点击资料条目/课程卡片                                    */
  /* ---------------------------------------------------------------- */
  function bindDocumentClicks() {
    document.addEventListener("click", function (e) {
      var matTrig = e.target.closest("[data-open-material]");
      if (matTrig) {
        renderMaterialDetail(matTrig.getAttribute("data-open-material"));
        return;
      }
      var courseTrig = e.target.closest("[data-course-card]");
      if (courseTrig) {
        renderCourseDetail(courseTrig.getAttribute("data-course-card"));
      }
    });
  }

  /* ---------------------------------------------------------------- */
  /* 启动                                                                */
  /* ---------------------------------------------------------------- */
  function boot() {
    bindDocumentClicks();

    function onReady() {
      var navAdmin = $("#nav-admin");
      if (navAdmin && !canManage()) navAdmin.hidden = true;

      var list = $("#course-list");
      if (list) {
        list.addEventListener("click", function (e) {
          var li = e.target.closest("[data-select-course]");
          if (li) renderCourseDetail(li.getAttribute("data-select-course"));
        });
      }
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", onReady);
    } else {
      onReady();
    }
  }

  boot();

  window.Enh = window.Enh || {};
  window.Enh.renderCourseDetail = renderCourseDetail;
  window.Enh.renderMaterialDetail = renderMaterialDetail;
  window.Enh.renderAdmin = renderAdmin;
  window.Enh.setViewState = setViewState;
})();
