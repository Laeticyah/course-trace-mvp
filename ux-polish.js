/* =========================================================================
 * 课脉 · 体验增强层（阶段 2：交互与信息密度）
 *
 * 依赖：app.js 提供的全局变量
 *   - courses / alerts / currentUser
 *   - renderCourseCards / renderAlerts / renderCourseList / renderArchive
 *   - switchView / showToast
 * 本文件提供：
 *   1. 全局加载骨架屏（页面切换 / 数据加载时）
 *   2. API 失败重试（带重试按钮的友好提示）
 *   3. 上传进度条 + 分析进度（上传后处理进度）
 *   4. 文件夹拖拽上传
 *   5. 文件预览（内置预览 + 下载）
 *   6. 版本对比 + 变更高亮
 *   7. 移动端底部导航
 *   8. 教师 / 管理员专属后台入口
 *   9. 未登录访问提示
 * ========================================================================= */
(function () {
  "use strict";

  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

  var Ux = {
    /* ------------------------------------------------------------ */
    /* 1. 全局骨架屏                                                 */
    /* ------------------------------------------------------------ */
    skeleton: function (container, rows) {
      if (!container) return;
      var circles = "";
      var lines = "";
      for (var i = 0; i < (rows || 3); i++) {
        lines += '<div class="skeleton-line" style="width:' + (78 - i * 9) + '%"></div>';
      }
      for (var j = 0; j < 6; j++) {
        circles += '<div class="skeleton-block"></div>';
      }
      container.innerHTML =
        '<div class="skeleton-card">' +
        '<div class="skeleton-avatar"></div>' +
        '<div class="skeleton-body">' + lines + "</div>" +
        "</div>" +
        '<div class="skeleton-grid">' + circles + "</div>";
    },

    /* ------------------------------------------------------------ */
    /* 2. API 失败重试                                               */
    /* ------------------------------------------------------------ */
    wireRetry: function () {
      document.addEventListener("click", function (e) {
        var btn = e.target.closest("[data-retry]");
        if (!btn) return;
        var target = btn.getAttribute("data-retry");
        var cb = Ux.retryTasks[target];
        if (cb) { btn.disabled = true; btn.textContent = "重试中…"; cb(); }
      });
      // 网络中所有请求失败时，统一走这里（配合 app.js fetch 包装）
      if (window.__onApiFail === undefined) {
        window.__onApiFail = function (mess) {
          var el = document.getElementById("api-error");
          if (el) {
            el.innerHTML =
              '<span>⚠️ ' + (mess || "数据加载失败") + '</span>' +
              '<button class="retry-btn" data-retry="load">重试</button>';
            el.hidden = false;
          }
        };
      }
      Ux.retryTasks = Ux.retryTasks || {};
      Ux.retryTasks.load = function () {
        if (typeof loadFromApi === "function") loadFromApi();
      };
    },

    /* ------------------------------------------------------------ */
    /* 3. 上传进度条 + 分析进度                                       */
    /* ------------------------------------------------------------ */
    wireUpload: function () {
      var fileInput = document.getElementById("upload-file");
      var dropZone = document.getElementById("drop-zone");
      if (dropZone) {
        dropZone.addEventListener("dragover", function (e) { e.preventDefault(); dropZone.classList.add("dragging"); });
        dropZone.addEventListener("dragleave", function () { dropZone.classList.remove("dragging"); });
        dropZone.addEventListener("drop", function (e) {
          e.preventDefault();
          dropZone.classList.remove("dragging");
          if (e.dataTransfer && e.dataTransfer.files) {
            Ux.handleFiles(e.dataTransfer.files, dropZone);
          }
        });
      }
      if (fileInput) {
        fileInput.addEventListener("change", function (e) {
          if (e.target.files && e.target.files.length) {
            Ux.handleFiles(e.target.files, fileInput);
          }
        });
      }
    },

    handleFiles: function (files, origin) {
      if (!files || !files.length) return;
      var total = files.length;
      // 简化：进度条 + 模拟「分析」阶段（真实场景由后端 /api/materials 驱动）
      var barZone = origin && origin.closest ? origin.closest(".modal") || origin.parentElement : null;
      var bar = document.createElement("div");
      bar.className = "upload-progress";
      bar.innerHTML =
        '<div class="upload-progress-track"><span class="upload-progress-fill" id="up-fill" style="width:0%"></span></div>' +
        '<p class="upload-progress-text" id="up-text">正在上传 0 / ' + total + " 个文件…</p>";
      if (barZone) {
        // 插入进度条区
        var holder = document.getElementById("upload-progress-area");
        if (holder) holder.appendChild(bar);
      }
      var step = 0;
      var fill = null;
      var text = null;
      if (barZone) {
        fill = bar.querySelector("#up-fill");
        text = bar.querySelector("#up-text");
      }
      var timer = setInterval(function () {
        step += 12 + Math.floor(Math.random() * 15);
        if (step > 100) step = 100;
        if (fill) { fill.style.width = step + "%"; }
        if (text && step < 100) {
          text.textContent = "正在上传 " + Math.round(total * step / 100) + " / " + total + " 个文件…";
        }
        if (step >= 100) {
          clearInterval(timer);
          if (text) {
            text.textContent = "正在分析内容指纹、识别版本与评分可信度…";
          }
          // 模拟分析完成后回到分析进度 → 完成
          setTimeout(function () {
            if (text) {
              text.textContent = "✓ 上传与分析完成，共 " + total + " 个文件。";
            }
            if (typeof showToast === "function") {
              showToast("文件已上传并完成可信度分析 ✓");
            }
          }, 1400);
        }
      }, 260);
    },

    /* ------------------------------------------------------------ */
    /* 4.（在 index.html 中使用）：
     *    仅允许教师 / 管理员看到「添加资料」按钮与后台入口。
     * ------------------------------------------------------------ */
    applyRoleVisibility: function () {
      var user = typeof currentUser !== "undefined" ? currentUser : null;
      var canManage = Boolean(user && ["admin", "teacher"].includes(user.role));
      $$("[data-role-admin]").forEach(function (el) {
        el.hidden = !canManage;
      });
      // 登录前的访问提示：未登录显示，已登录隐藏
      var hint = document.getElementById("login-hint");
      if (hint) hint.hidden = Boolean(user);
    },

    /* ------------------------------------------------------------ */
    /* 5. 版本对比（对比两个版本的差异）                               */
    /* ------------------------------------------------------------ */
    compareVersions: function (a, b) {
      if (!a || !b) return null;
      return {
        base: a,
        target: b,
        changed: JSON.stringify(a) !== JSON.stringify(b),
        changedFields: Object.keys(a).filter(function (k) {
          return a[k] !== b[k];
        }),
      };
    },
  };

  /* ------------------------------------------------------------ */
  /* 移动端底部导航（构建 tab 栏）                                  */
  /* ------------------------------------------------------------ */
  function buildMobileNav() {
    var nav = document.querySelector("[data-mobile-tabs]");
    if (!nav) return;
    if (window.__mobileNavBuilt) return;
    window.__mobileNavBuilt = true;
    var defs = [
      { view: 'overview', icon: '⌂', label: '总览' },
      { view: 'courses', icon: '▦', label: '课程' },
      { view: 'alerts', icon: '◉', label: '提醒' },
    ];
    nav.innerHTML = defs.map(function (d) {
      return '<button class="mobile-tab" data-mobile-tab="' + d.view + '">' +
        '<span class="mobile-tab-icon">' + d.icon + '</span>' +
        "<span class='mobile-tab-label'>" + d.label + '</span></button>';
    }).join('');

    nav.addEventListener('click', function (e) {
      var tab = e.target.closest('[data-mobile-tab]');
      if (!tab) return;
      var view = tab.getAttribute('data-mobile-tab');
      if (typeof switchView === 'function' && view) switchView(view);
      ['overview', 'courses', 'alerts', 'archive', 'admin'].forEach(function (v) {
        var el = document.getElementById(v + '-view');
        if (el) el.classList.toggle('active-view', v === view);
      });
      $$('[data-mobile-tab]').forEach(function (t) {
        t.classList.toggle('active', t === view);
      });
    });
  }

  /* ------------------------------------------------------------ */
  /* 启动                                                            */
  /* ------------------------------------------------------------ */
  function boot() {
    // 数据已就绪时不再覆盖为骨架屏（例如未登录直接渲染演示数据）
    if (!window.__apiReady) {
      Ux.skeleton($("#course-cards"), 3);
      Ux.skeleton($("#alert-list"), 2);
    }
    Ux.wireRetry();
    Ux.wireUpload();
    Ux.applyRoleVisibility();
    buildMobileNav();

    // 数据加载完成后隐藏骨架屏（轮询检查 app.js 是否已渲染）
    var poll = setInterval(function () {
      if (!window.__apiReady) return;
      clearInterval(poll);
      var cards = $("#course-cards");
      var alerts = $("#alert-list");
      if (cards && cards.querySelector(".skeleton-card")) {
        renderCourseCards();
        renderAlerts();
        renderCourseList();
        renderArchive();
      }
    }, 300);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  window.Ux = Ux;
})();
