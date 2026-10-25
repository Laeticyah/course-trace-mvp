# 课脉 · 课程资料版本治理与可信检索

课程资料治理层：把 Canvas 上的真实课程资料同步到本地，完成**资料归一、版本识别、权威判定、可信检索、变更提醒**。没有内置演示数据，页面上的课程与文件全部来自 Canvas 真实同步或本地上传。

## 运行

```powershell
npm install
npm start
```

启动后访问 `http://localhost:4173/`，接口基地址为 `http://localhost:4173/api`。
上传文件默认限制 25 MB，文件保存于 `uploads/<courseId>/`。

## 从 Canvas 导入真实课程

在 `.env` 中配置 Canvas（参考 `.env.example`）：

```text
CANVAS_BASE_URL=https://oc.sjtu.edu.cn
CANVAS_TOKEN=你的 Canvas Access Token
```

首次启动数据库是空的，需要用管理员账号把 Canvas 课程导入：

```powershell
# 1. 登录拿 token
$login = Invoke-RestMethod http://localhost:4173/api/auth/login `
  -Method Post -ContentType 'application/json' `
  -Body '{"username":"admin","password":"admin123"}'
$headers = @{ Authorization = "Bearer $($login.token)" }

# 2. 查看 Canvas 账号下可访问的真实课程
Invoke-RestMethod http://localhost:4173/api/canvas/courses -Headers $headers

# 3. 一键导入未入库课程（每门课创建一个同步任务，任务会下载真实文件并建立版本链）
Invoke-RestMethod http://localhost:4173/api/canvas/import-courses -Method Post -Headers $headers
```

也可以只同步某一门 Canvas 课程（数字 id）：

```powershell
Invoke-RestMethod http://localhost:4173/api/courses/97558/sync -Method Post -Headers $headers
```

同步过程可在页面顶部「同步」按钮查看进度/日志；同步出的资料会带真实本地文件，可下载。

## 接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/dashboard` | 获取首页课程和提醒 |
| GET | `/api/courses?q=工程` | 搜索课程 |
| GET | `/api/courses/:courseId/materials` | 获取课程资料 |
| POST | `/api/materials/upload` | 上传资料、计算 SHA-256、识别重复文件并加入版本链 |
| POST | `/api/materials` | 登记新资料（无附件）并加入版本链 |
| GET | `/api/materials/:materialId/file` | 鉴权下载资料附件（Bearer Token） |
| GET | `/api/search?q=需求` | 中文全文检索（FTS5 trigram + LIKE 兜底） |
| PUT | `/api/materials/:materialId/review` | 教师/管理员确认或撤销资料审核（仅限自己课程） |
| PUT | `/api/materials/:materialId/archive` | 归档/恢复资料 |
| DELETE | `/api/materials/:materialId` | 删除资料 |
| POST | `/api/courses/:courseId/sync` | 触发课程 Canvas 同步（202 + jobId；管理员可用 Canvas 数字 id 导入新课程） |
| GET | `/api/canvas/courses` | 列出 Canvas 上可访问的真实课程（管理员） |
| POST | `/api/canvas/import-courses` | 一键导入未入库的 Canvas 课程（管理员） |
| GET | `/api/sync-jobs` | 同步任务列表（教师仅自己/自己课程，管理员全部） |
| GET | `/api/sync-jobs/:id` · `/logs` · `/events` | 任务状态 / 日志 / SSE 进度流（均需 Bearer） |
| POST | `/api/auth/login` | 登录并获取 Bearer Token |
| GET | `/api/auth/me` | 获取当前登录用户 |
| POST | `/api/auth/logout` | 注销当前会话 |
| GET | `/api/me/courses` | 获取当前用户已加入的课程 |
| POST | `/api/courses/:courseId/join` | 学生加入课程 |
| DELETE | `/api/courses/:courseId/leave` | 学生退出课程 |
| GET | `/api/courses/:courseId/members` | 教师/管理员查看成员 |
| POST | `/api/courses/:courseId/members` | 教师/管理员添加成员 |
| DELETE | `/api/courses/:courseId/members/:userId` | 教师/管理员移除成员 |
| PUT | `/api/alerts/read` | 将提醒全部标为已读 |

上传文件示例：

```powershell
curl.exe -X POST http://localhost:4173/api/materials/upload `
  -H "Authorization: Bearer <token>" `
  -F "name=第三章需求分析课件" `
  -F "course=97558" `
  -F "type=课件" `
  -F "source=教师上传" `
  -F "file=@C:\资料\chapter-3.pdf"
```

上传接口会返回 `fileHash`、`version`、`versionChainId` 和 `duplicate`；相同文件不会重复创建版本。PDF/PPTX/DOCX 会提取文本与章节标题，相似度达到阈值时归入同一版本链。

## 权威版本评分

服务端按五因子加权计算 `authorityScore`（`lib/authority.js`）：

```text
权威度 = 来源权威度 × 35% + 时间新度 × 20% + 内容变更度 × 15% + 教师审核 × 20% + 内容完整度 × 10%
```

同一 `versionChainId` 内：教师审核通过的版本优先，否则取分数最高的未归档版本标记为 `isAuthoritative`；被新版本替代的旧版本自动归档，不再参与当前权威版评选。

## 已实现

- 课程资料总览、可信检索（中文 FTS5 + LIKE 兜底）、课程详情与真实版本时间线
- 变更提醒、历史归档（新版本自动归档旧版）
- 上传/登记：SHA-256 判重、版本链识别、鉴权下载
- Canvas 真实同步：异步任务队列（202 + jobId）、进度/日志/SSE、失败重试与超时、重启任务恢复、真实文件下载到 `uploads/<courseId>/`
- 权限：管理员可管理全部课程；教师只能管理自己担任教师的课程；学生只能查看已加入课程

## 测试

```powershell
npm test           # 单元测试 + 接口/安全测试（临时 SQLite + 临时 uploads + 随机端口，不访问真实 Canvas）
npm run test:unit  # 纯逻辑单元测试
npm run test:api   # 接口与安全测试
npm run cleanup:demo  # 清理历史演示数据（会先备份数据库到 backups/）
```

Canvas 同步成功链路（真实文件下载）需要有效 Token，由手工集成验证覆盖。

## 运行配置

| 变量 | 说明 |
| --- | --- |
| `PORT` | 服务端口，默认 4173 |
| `DB_FILE` | SQLite 数据库路径，默认 `./course-trace.sqlite` |
| `UPLOAD_DIR` | 上传目录，默认 `./uploads/` |
| `CANVAS_BASE_URL` / `CANVAS_TOKEN` | Canvas 实例与访问令牌 |
| `AUTO_SYNC_INTERVAL_MS` | 自动同步周期；默认每天 03:00，设为 0 关闭 |

数据库与上传文件不随代码提交（见 `.gitignore`）。

## 数据源与边界

- 课程与资料：仅来自 Canvas 真实 API 同步，或本地教师上传/登记；**不内置任何演示数据或 mock 数据**
- 文件：Canvas 同步会真实下载文件到 `uploads/<courseId>/`；下载接口需要登录并校验课程权限
- 数据库：本地 SQLite（`node:sqlite`），上线可迁移 PostgreSQL；当前为单实例文件存储
- 首次启动是空库，需要用管理员账号执行「导入 Canvas 课程」

## 内置账号与权限

| 账号 | 密码 | 角色 | 权限 |
| --- | --- | --- | --- |
| `student` | `student123` | 学生 | 查看已加入课程资料、查看提醒 |
| `teacher` | `teacher123` | 教师 | 学生权限 + 仅在担任教师的课程内上传/登记/审核/归档资料 |
| `admin` | `admin123` | 管理员 | 全部课程的治理权限 + Canvas 课程导入/同步管理 |

首次启动会自动创建这三个账号（`users` 表为空时），没有默认课程成员关系：同步创建课程时会把触发者登记为该课程教师；管理员不受课程限制。

审核请求示例：

```powershell
Invoke-RestMethod http://localhost:4173/api/materials/<material-id>/review `
  -Method Put -Headers @{ Authorization = "Bearer <token>" } `
  -ContentType 'application/json' `
  -Body '{"status":"approved","note":"教师确认当前版本有效"}'
```
