# 课脉 · 工程质量与部署方案

本文件描述课脉项目的测试策略、分层架构演进路径以及从 SQLite 本地版逐步迁移到生产环境的部署方案。

---

## 一、测试策略

### 1.1 测试层级

```
单元测试 (lib/logic.js 纯函数)
├── 权威度计算 calculateScore
├── 版本号生成 nextVersion
├── 文本规范化 normalizeText
├── 内容指纹 textFingerprint
├── 相似度计算 textSimilarity
└── 权限判断 canViewCourse / canManageMaterial

接口测试 (REST API, server 进程隔离)
├── /api/health           健康检查
├── /api/auth/*           登录 / 登出 / 会话
├── /api/dashboard        仪表盘聚合
├── /api/courses/...      课程资料列表与详情
├── /api/courses/:id/sync 触发同步任务(202 + jobId)
├── /api/materials/...    资料详情 / 审核 / 归档
├── /api/search           全文检索(FTS5 / LIKE 降级)
└── /api/sync-jobs/...    POST 同步(202)、轮询状态、日志

前端测试 (DOM / 交互)
├── 登录状态展示与权限跳转
├── 课程列表筛选（官方 / 学生 / 已归档）
├── 上传表单交互
├── 进度条与错误提示
└── 移动端底部导航
```

### 1.2 运行方式

```bash
# 单元测试（无需服务器）
node --test test/unit/

# 接口测试（自动启动独立 server 进程,测试后关闭）
node --test test/api/

# 全部测试
npm test
```

> 接口测试通过 `PORT` 环境变量使用独立端口（默认 4174），避免与开发服务器（4173）冲突。

### 1.3 覆盖率目标

| 层次 | 目标覆盖率 |
|------|-----------|
| 纯逻辑层（lib/logic.js） | ≥ 90% |
| 接口层（server.js 路由） | ≥ 70% |
| 前端交互层 | ≥ 60% |

---

## 二、架构分层

```
┌─────────────────────────────────┐
│  前端 (index.html + app.js)      │
│  └─ UX 增强层 (ux-polish.js)    │
├─────────────────────────────────┤
│  REST API (server.js)           │
├─────────────────────────────────┤
│  纯逻辑层 (lib/logic.js)        │
│   └─ 可信度 / 指纹 / 版本号     │
├─────────────────────────────────┤
│  数据访问层 (database.js)       │
│   └─ SQLite (开发) →             │
│      PostgreSQL (生产)          │
├─────────────────────────────────┤
│  对象存储                       │
│  └─ 本地 uploads/ (开发) →      │
│     S3 / OSS (生产)            │
└─────────────────────────────────┘
```

**分层原则**
- 纯运算逻辑（可信度、相似度）放在 `lib/logic.js`，无 I/O 副作用，可 100% 单元测试。
- `server.js` 只负责 HTTP 层：参数校验、鉴权、调用 logic、读写数据库。
- 存储层抽象出统一接口，便于 SQLite → PostgreSQL 平滑切换。

---

## 三、生产部署方案

### 3.1 推荐拓扑

```
Nginx (443/TLS)
   │
   ▼
Node.js API (主实例) ───────── 内存缓存 (可选 Redis)
   │
   ├── PostgreSQL (主库)
   ├── Redis (队列 / 会话 / 缓存)
   ├── S3 / OSS (对象存储)
   └── Worker (文件解析 / Canvas 同步)
```

### 3.2 环境配置

参考 `.env`:

```bash
# 服务
PORT=4173
NODE_ENV=production
HOST=0.0.0.0

# 数据库（生产建议 PostgreSQL）
DB_TYPE=postgres
DATABASE_URL=postgres://user:pass@host:5432/course_trace
# 开发仍可用
DB_TYPE=sqlite
DB_FILE=course-trace.sqlite

# 对象存储
STORAGE_DRIVER=s3          # 或 local, oss
S3_ENDPOINT=
S3_BUCKET=
S3_ACCESS_KEY=
S3_SECRET_KEY=

# Canvas 同步
CANVAS_API_URL=
CANVAS_TOKEN=
CANVAS_SYNC_INTERVAL_MS=86400000

# 安全
JWT_SECRET=your-secret      # 生产必填
JWT_EXPIRES=7d
CORS_ORIGIN=https://your-domain.com
```

### 3.3 升级步骤（本地 → 生产）

| 阶段 | 存储 | 说明 |
|------|------|------|
| 开发 | SQLite + 本地 uploads/ | 当前状态，零外部依赖 |
| 测试 | SQLite (可) / PostgreSQL + MinIO | 通过 `DB_TYPE` `STORAGE_DRIVER` 切换 |
| 生产 | PostgreSQL + S3/OSS + Redis | 主从或多可用区 |

**迁移步骤**

1. **数据库迁移**
   - 用 Node 内置 `node:sqlite` 读取现有数据。
   - 用 SQL 迁移脚本导入 PostgreSQL（`node-pg-migrate` 或自写幂等迁移）。
   - `database.js` 提供 `DB_TYPE` 切换不同的存储适配器。

2. **对象存储迁移**
   - 本地 `uploads/<courseId>/` → 批量同步到 S3/OSS Bucket。
   - 文件访问 URL 改为签名 URL 或 CDN 前缀。

3. **静态资源**
   - `index.html` / `app.js` / `ux-polish.js` / `styles.css` 前端文件可挂 CDN 或静态目录。

4. **反向代理与 TLS**
   - Nginx 增加 HTTPS + gzip + 静态资源缓存头 + API 反代。

### 3.4 进程管理与观测

```bash
# 推荐 pm2
pm2 start server.js -i 2 --name course-trace

# 或 systemd
# ExecStart=/usr/bin/node /srv/course-trace/server.js
```

- 日志统一 stdout + journald / 采集到 Loki
- 健康检查依赖 `/api/health`
- 就绪探测依赖数据库连通性（可新增 `/api/ready`）

### 3.5 韧性建议

- **重试与退避**：同步任务已有 `maxAttempts` 概念，建议指数退避策略。
- **限流**：对 `/api/materials`、`/api/search` 增加简单限流。
- **数据备份**：SQLite 每日备份；PostgreSQL 用 RDS 自动备份。
- **无状态**：会话使用 JWT，节点可水平扩展。

---

## 四、落地清单（canary 步骤）

- [x] 单元测试搭建（lib/logic.js 19/19 通过）
- [ ] 将 server.js 中内联算法切换到 lib/logic.js，保证「测试 = 运行时代码」
- [ ] 接口测试在 CI 中自动跑（独立端口 + 自动启停 server）
- [ ] 前端测试接入 jsdom（登录状态、筛选、上传表单、错误提示）
- [ ] 编写 `DB_TYPE=postgres` 适配层（只读迁移 + 读写 CRUD）
- [ ] 编写 S3 存储适配层（上传 → 签名下载地址）
- [ ] 增加 `/api/ready` 就绪探针
- [ ] 补充 Nginx 配置示例与 systemd unit 文件
