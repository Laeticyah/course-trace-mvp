# 课脉 · 课程资料版本治理与可信检索

这是根据《项目建议书_v3_资料治理》和答辩 PPT 搭建的可演示 MVP。项目以学生侧的课程资料治理层为定位，围绕“资料归一、版本识别、权威判定、可信检索、变更提醒”形成最小闭环。当前已提供 Express REST API，前端通过 `/api` 读取和更新数据。

## 运行

安装依赖并启动接口服务：

```powershell
npm install
npm start
```

启动后访问 `http://localhost:4173/`，接口基地址为 `http://localhost:4173/api`。
上传文件默认限制为 25 MB，文件暂存于本地 `uploads/` 目录。

## 接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/dashboard` | 获取首页课程和提醒 |
| GET | `/api/courses?q=工程` | 搜索课程 |
| GET | `/api/courses/:courseId/materials` | 获取课程资料 |
| POST | `/api/materials` | 登记新资料并加入版本链 |
| POST | `/api/materials/upload` | 上传资料、计算 SHA-256、识别重复文件并加入版本链 |
| PUT | `/api/alerts/read` | 将提醒全部标为已读 |
| POST | `/api/auth/login` | 登录并获取 Bearer Token |
| GET | `/api/auth/me` | 获取当前登录用户 |
| POST | `/api/auth/logout` | 注销当前会话 |
| PUT | `/api/materials/:materialId/review` | 教师/管理员确认或撤销资料审核 |
| GET | `/api/me/courses` | 获取当前用户已加入的课程 |
| POST | `/api/courses/:courseId/join` | 学生加入课程 |
| DELETE | `/api/courses/:courseId/leave` | 学生退出课程 |
| GET | `/api/courses/:courseId/members` | 教师/管理员查看成员 |
| POST | `/api/courses/:courseId/members` | 教师/管理员添加成员 |
| DELETE | `/api/courses/:courseId/members/:userId` | 教师/管理员移除成员 |

新增资料示例：

```powershell
Invoke-RestMethod http://localhost:4173/api/materials `
  -Method Post -ContentType 'application/json' `
  -Body '{"name":"第三章需求分析课件","course":"eng101","type":"课件","source":"Canvas"}'
```

上传文件示例：

```powershell
curl.exe -X POST http://localhost:4173/api/materials/upload `
  -F "name=第三章需求分析课件" `
  -F "course=eng101" `
  -F "type=课件" `
  -F "source=Canvas" `
  -F "file=@C:\资料\chapter-3.pdf"
```

上传接口会返回 `fileHash`、`version`、`versionChainId` 和 `duplicate`。相同文件再次上传时只返回已有资料，不会重复创建版本。对于 PDF/PPTX/DOCX，服务端还会提取文本、章节标题和字数；与历史资料内容相似度达到阈值时，会自动归入同一版本链，并返回 `similarity` 与 `versionReason`。

## 权威版本评分

服务端按以下可解释规则计算 `authorityScore`：

```text
权威度 = 来源权威度 × 50% + 时间新度 × 30% + 内容变更度 × 20%
```

来源权威度默认排序为 Canvas（1.00）、教师上传（0.95）、知途好课（0.92）、班级群（0.58）、网盘（0.48）、转发（0.40）。同一 `versionChainId` 内分数最高的资料会标记为 `isAuthoritative: true`，并显示“最新权威版”；其他官方资料显示“官方历史版”。

## 已实现

- 课程资料总览：课程卡片、资料数量、治理进度、最近更新
- 可信检索：课程关键词搜索、官方资料/学生整理/最近更新筛选入口
- 课程详情：资料来源、版本号、权威状态和版本时间线
- 变更提醒：官方课件和作业要求更新提醒、已读状态
- 历史归档：被替代版本的可回溯列表
- 资料登记：模拟接入资料后生成版本链并刷新界面
- 响应式布局：适配窄屏和移动端宽度

## 真实接入边界

当前使用本地 SQLite 数据库 `course-trace.sqlite` 保存课程、资料、版本链和提醒。首次启动会自动把已有 `data.json` 导入 SQLite；之后接口读写数据库，不再依赖 JSON 文件。仍未接入 Canvas、知途好课、班级群或网盘，正式部署时可继续将 SQLite 迁移到 MySQL/PostgreSQL。

## 演示账号与权限

| 账号 | 密码 | 角色 | 权限 |
| --- | --- | --- | --- |
| `student` | `student123` | 学生 | 查看资料、查看提醒 |
| `teacher` | `teacher123` | 教师 | 学生权限 + 上传和登记资料 |
| `admin` | `admin123` | 管理员 | 教师权限 + 管理能力预留 |

上传资料和标记提醒已读需要在请求头中携带：

```text
Authorization: Bearer <登录接口返回的 token>
```

审核请求示例：

```powershell
Invoke-RestMethod http://localhost:4173/api/materials/<material-id>/review `
  -Method Put -Headers @{ Authorization = "Bearer <token>" } `
  -ContentType 'application/json' `
  -Body '{"status":"approved","note":"教师确认当前版本有效"}'
```

## 课程成员

学生登录后只会看到已加入课程的资料和提醒。演示数据中，`student` 默认加入“工程学导论”，`teacher` 默认负责三门课程；教师新增资料产生的提醒会随课程成员过滤。
