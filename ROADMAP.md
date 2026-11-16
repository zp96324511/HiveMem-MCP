# HiveMem-MCP v2 实施路线图

> 进度管理文档。设计依据：[DESIGN.md](DESIGN.md) §13。每完成一项勾选并注日期；每阶段收尾跑 `npm test` 全绿 + hub 重启（`Start-ScheduledTask HiveMemHub`）+ 真实数据验证。

**当前阶段：Phase C（可选后续）**

## Phase A：记忆作用域分层（用户/项目/设备/agent）✅ 2026-10-27 完成

- [x] A1 schema v4：`memories.device`/`agent` 列 + `idx_memories_scope` + `devices` 自动登记表（迁移循环化，v5 直接追加）
- [x] A2 `@user` 保留项目：无 marker 创建、`resolveProject('@user')` 解析、uniqueName 守卫、REST 创建/改名 409 守卫
- [x] A3 请求上下文：`X-HiveMem-Device` 解析 + `os.hostname()` 回退 + 设备登记 upsert（`src/scope.ts`）
- [x] A4 `writeMemory` scope 分支 + topic upsert 作用域匹配（同 key 不同设备不互相修订）
- [x] A5 `bootstrapBrief` 四段组装：用户级优先（~500 字）→ 项目级（现有三区+最近更新）→ 设备级 → agent级；预算硬不变量 rendered ≤ budget
- [x] A6 `searchMemories` 作用域标注 + `projectIds`/`scope` 过滤；用户级记忆默认参与所有项目检索（MCP/REST 同步）
- [x] A7 `updateMemory` 跨作用域迁移（device/agent 标签清除语义 + moveMemory 入 @user）
- [x] A8 MCP：memory_write/search/update 增 `scope` 参数、SERVER_INSTRUCTIONS 分层写入指南、brief 资源上下文感知；**scope=agent 无工具身份显式报错（不静默降级）**
- [x] A9 REST：memories 读写 scope、`GET /api/devices`、`GET /api/brief`、stats 增 byScope/devices
- [x] A10 web：作用域徽章（用户/设备:名/工具:名）、写入表单 scope 选择（仅变更时发送防误标记）、作用域过滤、统计卡片、@user 项目 👤 标识、api() 统一携带 X-HiveMem-Agent: web
- [x] A11 `test/scope.test.ts`：10 个新测试（@user/写入往返/简报四段/搜索标注/topic 作用域/跨层迁移/设备身份/统计分层/hub 端到端含静默降级拒绝）
- [x] A12 收尾：**50/50 测试全绿**、构建通过、hub 重启部署、真实数据验证（37 条存量零迁移全归 project 层；用户级跨项目简报、设备/工具段按上下文出现与隐藏均验证通过）、README/DESIGN 更新

## Phase B：多用户权限 ✅ 2026-10-27 完成

- [x] B1 schema v5：`users`/`tokens`/`sessions`/`grants` + `projects.owner_user_id`；项目名唯一性改 (owner, name)（每用户独立 @user 行）
- [x] B2 存量迁移：**无用户 = legacy 单用户模式（向后兼容，现有部署零感知）**；首用户创建时强制 admin 并认领全部无主项目；`--adopt-env-token` 可接管现有 HIVEMEM_TOKEN
- [x] B3 认证：`src/auth.ts`（scrypt 密码、token SHA-256 哈希查表、session cookie 哈希）+ `/api/auth/login|logout|me` + CLI `user add/passwd/list/token`
- [x] B4 访问控制：`assertProjectAccess` 贯穿 MCP `resolve()` 与 REST `resolveChecked`；非管理员名称解析 owner 优先、错误提示不泄露他人项目名；全局检索/项目列表/统计按可访问集过滤（含空集守卫防漏权）
- [x] B5 授权语义：受权项目只读强制（写 403）、撤销即时生效（每请求重算）、grants REST 仅 admin；FORBIDDEN→403 映射
- [x] B6 web 登录页（多用户模式强制）+ 侧栏用户身份/退出 + 管理员页（用户增删改/令牌生成只显示一次/授权授予与撤销）+ 非本有项目「只读」徽章 + legacy 模式提示与首用户引导
- [x] B7 CLI 用户管理命令（user add/passwd/list/token、--adopt-env-token）+ README 多用户章节（含 DSH 每用户配置与 TLS 部署要求）
- [x] B8 `test/multiuser.test.ts`：7 个新测试——auth 基元/首用户认领/legacy 兼容/token 吊销/会话失效/访问检查矩阵/hub 端到端（legacy→首用户→隔离→授权→撤销→每用户 @user→token 吊销踢出）——**57/57 全绿**
- [x] B9 收尾：hub 重启部署（真实库 v5 迁移 + legacy 模式零破坏验证）、README/DESIGN/ROADMAP 更新、web UI 加载与 auth 端点验证

## Phase C：管理完善（后续可选）

- [x] C2 设备/agent 注册表管理页 ✅ 2026-10-28（v0.3 统计视图内嵌设备注册表）
- [ ] C1 授权审计展示
- [ ] C3 `@user` 层授权（知识分享）评估

## Phase D：Web 管理面板层次化重设计 ✅ 2026-10-28（v0.3.0）

用户反馈"面板太简陋，记忆的层次结构体现不出来"→ 以四层作用域为第一导航轴的完整重写：

- [x] D1 后端：`GET /api/tree`（作用域树聚合，一次返回嵌套计数；非管理员可访问集过滤）、memories 检索 `device`/`agent` 精确标签参数、POST/PATCH 显式作用域标签（web 面板跨设备管理）、PATCH topic_key、多用户 @user 作用域派生修正（scopeOf/scopeCondition/projectStats 从硬编码 prj_user 改为按名解析，第二用户 @user 行正确派生 user 层）
- [x] D2 设备注册防污染：只登记显式 X-HiveMem-Device 头（hostname 回退不再写入注册表）
- [x] D3 前端单文件重写：作用域树侧栏 / 总览（四层卡片+项目构成）/ 分层分组浏览（卡片+表格双视图）/ 详情抽屉（演进链时间线+复审+新版本取代）/ 简报预览（上下文感知）/ 编辑器（作用域卡片选择器+显式标签 datalist）/ 复审队列 / 统计（层分布+设备注册表+GC）/ 审计 / 多用户管理（令牌生命周期+表单化授权）
- [x] D4 `test/web.test.ts` 3 个新测试（树结构/精确过滤/显式标签/多用户可见性）——**62/62 全绿**
- [x] D5 本地真实数据验证（50 条记忆快照 + Chrome CDP 全流程实测：登录→总览→项目分层→详情→简报→编辑器写入设备级→删除）+ 1Panel 部署上线

## Phase E：简报覆盖率与枚举通道 ✅ 2026-11-08

用户质疑「2600 字简报是否会让 80+ 条记忆的项目丢索引」→ 实测（85 条项目级 + 4 条设备/工具）2600 预算下只进 13 条，且正文无任何提示：

- [x] E1 复盘点：2600 硬编码于 3 处调用（MCP 工具 / brief resource / REST `/api/brief`），无 env 与项目级配置；截断只返回 `truncated:true`——没有总数、没有指针，agent 会把"只看到 13 条"当成"项目只有 13 条"
- [x] E2 `store.listIndex()` + `indexCounts()`：标题级枚举（无 schema 变更），`total` 恒为匹配总数、`next_offset` 分页，kind/scope 过滤 + updated/importance/title 排序
- [x] E3 简报完整性页脚：末尾「本项目 N 条 active 中列出 M 条；全量索引 memory://projects/{id}/index 或 memory_index」，按 5%/≤120 字符预留（页脚本身不被截断吃掉）；`BootstrapBrief` 新增 `total`/`shown`
- [x] E4 MCP 面：`memory_index` 工具（第 9 个）+ `memory://projects/{id}/index` 资源（≤500 条；URI 不带 query——SDK 模板整串匹配，过滤分页走工具）；SERVER_INSTRUCTIONS 增「truncated=true 必须拉全量」
- [x] E5 关键取舍：**不靠加大 budget**——常驻上下文成本线性增长，且覆盖率上限由 LIMIT（置顶10/决策15/事实类10/最近8）卡在 ~38 条；改为"简报常驻小 + 索引按需全"，硬约束「每个列表 API 必须返回 total」
- [x] E6 测试：`total/分页边界/scope 隔离`、`截断页脚含总数与指针`、`完整时不加页脚`、MCP `memory_index` + index resource 端到端——**73/73 全绿**`n- [x] E8 冒烟发现的假阳性：旧实现里「某段放不下但行都已在别处列出」也置 truncated=true（12 条全列出仍报截断）；改为结尾统一判定 `truncated = userCut || projectShown < projectTotal`，并断言 `truncated === (shown < total)`
- [x] E7 部署上线 2026-11-08：镜像 `hivemem:0.3.3`（compose 备份为 `docker-compose.yml.0.3.2.bak`）；19189 冒烟容器验证 9 工具 / index resource / 页脚含总数与指针；线上 health=healthy、Restarts=0、342 条记忆 36 项目完整；ai-agent 实测简报「68 条 active 中列出 8 条」+ 页脚指针

## 里程碑

| 日期 | 事件 |
|---|---|
| 2026-10-27 | v2 设计定案（DESIGN.md §13），路线图建立，Phase A 启动 |
| 2026-10-27 | **Phase A 完成**：50/50 测试全绿，hub 部署，真实数据验证四层简报；Phase B 启动 |
| 2026-10-27 | **Phase B 核心完成**（B1-B5/B7/B8）：57/57 测试全绿，v5 已部署真实 hub（legacy 模式零破坏验证通过）；余 B6 web 登录界面 |
| 2026-10-27 | **Phase B 全部完成**（含 B6 web 登录/管理员页 + B9 文档收尾）：v2 交付。Phase C（授权审计展示/设备管理页/@user 授权评估）为可选后续 |
| 2026-10-27 | setup v2 升级：`--token`/`--device` 参数，已有条目**原地补头**（不重复、不碰邻居条目）；`~/.dsh/AGENTS.md` 同步 v2（四层 scope 指引、凭证条款修正、401 故障处理）。58/58 测试 |
| 2026-10-28 | 1Panel 容器化部署方案定稿（DEPLOY-1PANEL.md）并确认决策：**hivemem.zpzp.xyz + 直接多用户 + 存量迁移 + 本地 hub 停用 + v0.2.0**；DNS 通配符已覆盖，开始执行 |
| 2026-10-28 | **1Panel 部署完成**：hivemem:0.2.0 容器（127.0.0.1:19180）+ 站点 id=22 https://hivemem.zpzp.xyz（通配符证书）+ 多用户上线（admin zp 认领 10 项目）+ 50 条记忆迁移（SHA256 校验一致）+ 每日 04:30 备份 + DSH patch 切远程；本地 hub 停用保留回滚 |
| 2026-10-28 | 线上热修：0.2.1 中心化路径解析回退（他会话）、0.2.2 /api/auth/me 豁免认证门（他会话）、**0.2.3 Web 登录"不跳转"修复**（hidden 属性被 display:flex 覆盖，一行 CSS `[hidden]{display:none!important}`；Chrome CDP 实测复现→修复→退出重登全流程验证） |
| 2026-10-28 | **v0.3.0 Web 管理面板层次化重设计上线**：作用域树导航 + 分层浏览 + 详情抽屉（演进链）+ 简报预览 + 设备注册表 + 复审队列；后端新增 /api/tree 与显式作用域标签，修正多用户 @user 作用域派生；62/62 测试全绿，本地真实数据 + 线上双验证 |
| 2026-10-29 | **v0.3.1 bootstrap 按名自动注册项目**：HTTP 模式下 memory_bootstrap 传新项目名即自动创建（created 标记 + 既有项目列表供 agent 核对笔误；多用户下归属创建者），消除中心化部署"新项目需去面板手动建"的缺口——对齐 stdio 模式"读工具注册行"语义；写/检索保持严格报错防碎片化；路径引用不自动创建。64/64 测试全绿 |
| 2026-11-04 | **v0.3.2 项目删除上线**：`DELETE /api/projects/:id`（非空项目必须 `confirm=项目名`、`@user` 保留行 409、仅所有者/管理员）+ 面板侧栏项目节点 ✕ 与删除弹窗（级联范围说明 / 输入项目名 / 可选删 `.hivemem/project.json`）；记忆显式 DELETE 保证 FTS5 外部内容索引触发器执行，级联清向量/别名/授权，审计留 `project_delete` 记录；`GET /api/projects`、`/api/tree` 增 `marker_exists`。68/68 测试全绿 |
| 2026-11-08 | **Phase E（简报覆盖率 + memory_index）**：实测 85 条项目级只进 13 条 → 完整性页脚 + 枚举通道；MCP 工具增至 9 个，73/73 测试全绿；**v0.3.3 已部署线上，ai-agent 实测页脚生效** |
| 2026-11-11 | **v0.4.0 五件套（对标 PowerContext）**：①乐观并发 CAS（`version` + `expected_version`/`If-Match` → `REVISION_CONFLICT`）②`memory_revisions` 版本可寻址（`at_version`，删除后仍可读）③证据链 `evidence`（kind+locator+quote，topic 修订累积 / update 全量替换）④DSH 前置注入插件 `dsh-plugin/`（pre-step 预取 + systemPrompt.context 注入，fail-open）+ `hivemem brief` CLI ⑤真子进程端到端验收。88/88 测试全绿（新增 revisions 10 / 插件 4 / 验收 1），面板补版本徽章·证据链·版本历史 |
| 2026-11-11 | **v0.4.1 简报自解释**：逐条 `v{version}` 与被裁标记、缺失原因双计数（`omitted.budget/priority`）、用户级那层被裁也单独说明（`userLevel`）、`?budget=` 预算协商（服务端保证不超、插件不再二次裁、MCP `memory_bootstrap` 同样接受 `budget`）、插件补 `X-HiveMem-Device`/`X-HiveMem-Agent`、未注册项目注入可见提示（404 而非静默空串）。95/95 测试全绿，已部署线上（镜像 `hivemem:0.4.1`，healthy / Restarts=0） |
| 2026-11-11 | **Phase H 插件真机修复**：装进 web profile 后注入的项目名是 `win10`——cordis 对未 inject 的服务访问抛错被吞、退到 `process.cwd()`。改为 `ctx.reflect` → `session.header.cwd` → `process.cwd()` 三级链，并在「未注册」提示里写明项目名取自哪个目录；测试假宿主改为模仿真实 cordis（直读 throw）。`npm test` 98/98、`check:plugin` 14/14。同时清掉 `hivemem:0.3.3`/`0.4.0` 镜像（镜像级回滚自此不可用，只剩从源码 rebuild） |
| 2026-11-11 | **v0.4.2 指令与注入对齐**：`SERVER_INSTRUCTIONS` 与 `memory_bootstrap` 工具描述改成条件式（已有「## HiveMem 项目简报（自动注入」段就不调），注入段落头部补一句「不必再调用 memory_bootstrap」。线上镜像 `hivemem:0.4.2`（healthy / Restarts=0），全新库冒烟确认 `serverInfo.version=0.4.2`、instructions 新句在旧句已无、9 工具、brief 预算仍守 |

## Phase F（v0.4.0）：并发、历史、证据、前置注入

来源：与 [OceanBase PowerContext](https://github.com/oceanbase/powercontext) 的对比分析（2026-11-10）。只抄五个结构性缺口，明确不抄其 LLM 抽取管线、调度器、Python 重栈与 K8s 编排。

- [x] F1 乐观并发：`memories.version`（CAS token）+ `expected_version` / `HTTP If-Match`；冲突带 `detail.current_version/title`
- [x] F2 版本可寻址：`memory_revisions`（变更前完整行快照，无外键）+ `readMemoryAt` / `GET ?at_version=` / `GET /:id/revisions`
- [x] F3 证据链：`evidence` JSON 数组（7 种 kind，上限 12），`memory_write`/`memory_update` 接受，MCP/HTTP/面板三层可见
- [x] F4 前置注入：`dsh-plugin/`（`agent/pre-step` 预取 → `systemPrompt.context` 注入；TTL+单飞+fail-open）+ `hivemem brief` CLI 兜底
- [x] F5 确定性验收：`test/acceptance.test.ts` 两个真 MCP 进程 + 真 hub + 插件注入 + CLI，跨进程召回
- [x] F6 面板：版本徽章、证据链段、版本历史（点开读只读快照）
- [x] F7 线上部署 v0.4.0（2026-11-11 08:01 服务器本机时间）：镜像 `hivemem:0.4.0`（build 上下文 `/opt/hivemem-build`，8 个改动文件 scp 后 sha256 逐个核对）；先在 19189 端口用**生产库的 VACUUM INTO 快照**冒烟——user_version 5→6、375 条记忆全部 version=1/evidence='[]'、memory_revisions 建表成功；再用全新库验 API（建项目→建记忆带 evidence→`expected_version=1` 改到 v2→陈旧 `If-Match: W/"1"` 得 409 `REVISION_CONFLICT`→`?at_version=1` 拿到旧正文→`/revisions` 列 v1）与 MCP `serverInfo.version=0.4.0`。切换：备份 compose 为 `docker-compose.yml.0.3.3.bak` + 迁移前库快照 `data/backup/pre-0.4.0-20261111-0800.db`，sed 镜像 tag 后 `docker compose up -d`；校验 health=healthy、Restarts=0、线上库 375 条/39 项目完整、面板新 UI 标记就位、`https://hivemem.zpzp.xyz` 200、真实用户 token 下 `/api/brief` 与 MCP initialize 均通

## Phase G（v0.4.1）：让截断与缺失变成可读的事实

来源：v0.4.0 上线后对 PowerContext 截断机制（`prepared_text.py` 的二分裁剪 + `omissions` 双计数 + 引用不可截断）的逐条比对，以及「插件从尾部裁剪会切掉页脚」的实测漏洞。原则一句话：**沉默是最贵的错误**——读者看到一份短简报会默认那就是全部。

- [x] G1 简报自解释：`curatedLine` 输出 `- [id] v{version} 标题：正文`，正文被 `clip` 裁过时该行自带「（已截断）」；`indexLine` 同样带 `v{version}`。版本号即 CAS token，可读即可带 `expected_version` 写回
- [x] G2 缺失原因拆分：按两个集合（`candidateIds` 选中过 / `renderedIds` 真写进正文）算 `budgetDrops` 与 `priorityDrops`，`truncated` 与页脚「未列出 N 条 = 预算 k 条 + 名额 j 条」一致，机器可读的 `omitted: {budget, priority}` 满足 `budget + priority === total - shown`
- [x] G3 预算协商：`GET /api/brief?budget=N`（夹 512..8000，非法值 400 `INVALID_INPUT`，服务端保证 `rendered.length ≤ N`）；插件改按 `maxChars − 头部` 换请求预算
- [x] G4 禁止下游二次裁剪：删除插件 `clipText`；`frameBrief` 只校验不裁剪，超出返回单行提示 + `stats.oversize`，仅当 `snapshot.truncated` 且正文未自带标记时补页脚。修掉「hub 未截断但插件 maxChars 更小 → 静默丢尾部且无指针」
- [x] G5 作用域头：插件发送 `X-HiveMem-Device`（默认 `os.hostname()`，`HIVEMEM_DEVICE`/`device` 覆盖）与 `X-HiveMem-Agent`（默认 `dsh`），设备/工具两层记忆才会被选进简报
- [x] G6 未注册可见：`PROJECT_NOT_FOUND` 不再注入空串，改为注入一行「本项目「X」尚未注册，需要时调用 `memory_bootstrap`」，保留 fail-open；`/api/brief` 与 REST 路由的状态映射新增 `PROJECT_NOT_FOUND → 404`（与「不存在」同义，不泄露他人项目）
- [x] G7 验收：95/95 测试全绿（store 16 / scope 10 / 插件 7 / core 14 / MCP 7 等），`npx tsc --noEmit` 干净；多用户隔离用例改为断言 404（`test/multiuser.test.ts:206`）
- [x] G8 用户级那层被裁也说明：`@user` 是另一个项目、不进 `total`，旧行为下 `truncated=true` 却没有任何一行解释。现在项目正文完整时也单独输出「用户级记忆 N 条中列出 M 条（全量用 memory_index scope=user）」，并返回 `userLevel: {total, shown}`（线上实测 8 条中列出 3 条）
- [x] G9 线上部署 v0.4.1（2026-11-11 10:27 服务器本机时间）：`docker build -t hivemem:0.4.1`（9 个改动文件 scp 后 sha256 逐个核对）→ 先在 19189 用**生产库 VACUUM INTO 副本**冒烟（378 条记忆 / 40 项目 / user_version 6）→ 全新库验 `?budget=`（600→566 字、13 条预算丢弃、`omitted` 求和成立、非法值 400、未知项目 404）+ CAS/`/revisions`/`at_version` → 备份 `data/backup/pre-0.4.1-20261111-1027.db` + `docker-compose.yml.0.4.0.bak` → 切 tag → 线上 healthy、Restarts=0、`package.json` 0.4.1、MCP `serverInfo.version=0.4.1`、`memory_bootstrap` 暴露 `project,task_hint,budget`、真实 token 下简报带版本号与两级页脚

**未做（刻意）**：简报分页（策展视图只有预算与指针，枚举走 `memory_index`）、插件自动建项目（绕开显式注册防线，留给 `createOnMiss` opt-in）、逐条字节级二分裁剪（行级标记已足够定位「哪条被裁」）

## Phase H（v0.4.1 补丁）：把插件装进真实宿主

上线后把 `hivemem-dsh` 装进本机 web profile，第一次真跑就暴露了一个「测试全绿、线上错」的问题：注入的项目名是 `win10`（宿主进程目录的用户名），而不是会话目录 `C:\data\projects\HiveMem-MCP`。

- [x] H1 根因：cordis 对**未在 `inject` 里声明**的服务访问会抛 `cannot get property "workingDirectory" without inject`，插件里的 `try/catch` 把它吞了 → 落到 `process.cwd()`。假宿主当年直接挂了 `workingDirectory: { get }`，所以 7 个测试全绿而线上必错
- [x] H2 三级目录解析：`ctx.reflect.get('workingDirectory')?.get(session)`（injection-free 读）→ `session.header.cwd`（会话 header 记着创建目录，不受投影初始化时序影响）→ `process.cwd()`，且仅在第三级时 warn 一次
- [x] H3 错误可诊断：未注册提示第三行写明「项目名取自会话目录：…」，让「名字为什么错」能从 prompt 直接看出来（`notFoundNotice(project, cwd)`）
- [x] H4 测试改成模仿真实 cordis：`get workingDirectory()` 主动 throw、服务缺席时 `reflect.get` 返回 `undefined`、session 形如 `{header:{cwd}}`；`test/acceptance.test.ts` 的假宿主同改。新增插件测试 3 个（服务优先 / header 兜底 / 无来源时提示带目录），core 测试补 notice 断言
- [x] H5 安装与升级路径写清：`~/.dsh/profiles/web` 由 pnpm 管，`pnpm add file:<repo>/dsh-plugin` 是**拷贝**（改代码要重装；npm 的 `file:` 才是符号链接）；插件模块在宿主进程启动时已 import，**磁盘改对了也要重启宿主才生效**。`dsh-plugin/README.md` 增「排障」节
- [x] H6 AGENTS.md 纪律手工补齐（v0.4.1 的 CAS/证据链/历史读取三条 + 「上下文已有注入时不要再调 `memory_bootstrap`」），并在 DESIGN §15.3 记录目录解析链
- [x] H7 指令通道与注入对齐（v0.4.2）：插件上线后 `SERVER_INSTRUCTIONS` 里「会话开始处理第一个任务前，调用 `memory_bootstrap`」仍在，模型照做会拿第二份简报。改成条件式（先看上下文有没有「## HiveMem 项目简报（自动注入」段），同一句话写进三处：`SERVER_INSTRUCTIONS`、`memory_bootstrap` 工具描述、注入段落头部。2026-11-11 14:56 部署线上：镜像 `hivemem:0.4.2`，冒烟（全新库）确认 `serverInfo.version=0.4.2`、instructions 含新句不含旧句、9 个工具、brief 预算仍守 600；生产容器 healthy / Restarts=0、库 384 条 / 40 项目 / user_version 6、未带令牌的 `/mcp` 仍 401

**已知遗留**：`hivemem setup` 只写 `cordis.patch.yml`，不写 `AGENTS.md`；新环境的「行为纪律」仍是手工（可行方案见记忆 `setup/agents-md-automation`：哨兵区块 + `setup --agents-md` 幂等替换，未实施）

## Phase I（v0.4.3）：HTTP 模式把 project 变成硬契约

来源：新会话里 `memory_search` 只传 query 后报 `PROJECT_REQUIRED`。根因不在 AGENTS.md 措辞，而在 MCP schema 允许省略：`projectSchema` 在 HTTP 模式仍是 optional，tools/list 的 required 为空，描述却写 project 必填；`memory_search` 还写着“默认当前项目”，HTTP 模式根本无从推断。

- [x] I1 schema 收紧：HTTP 模式 `projectSchema` 改 `z.string().min(1)` 必填，bootstrap/search/index/read/update/archive/review/stats 的 tools/list required 均含 `project`；唯一例外 `memory_write` 用 `writeProjectSchema`（scope=user 可省，其余 scope 仍由 resolve 强制）
- [x] I2 指令与描述同步：`SERVER_INSTRUCTIONS` 新增「调用约定（HTTP 部署，优先级高于各工具描述）」；search/index 的“默认当前项目”改为“project 指定项目”；read/update/archive/review 描述补「HTTP 模式必须传 project」；`PROJECT_REQUIRED` hint 改成「补 project 后原样重试」
- [x] I3 插件注入头：`briefHeader` 第三行明确 `调用任何 memory_* 工具时都要带 project="…"`；预算按实际表头长度扣减，长项目名不再顶破 `maxChars`
- [x] I4 AGENTS.md：全局 `~/.dsh/AGENTS.md` 改为「每一次 memory_* 必须显式带 project（唯一例外 memory_write + scope=user）」并说明 PROJECT_REQUIRED 的重试动作
- [x] I5 验收：`npm test` 98/98（MCP 用例改为断言 schema required，memory_write 例外）、`npm run check:plugin` 15/15、typecheck/build 干净；dist 实测 required 与预期一致
- [x] I6 线上部署 v0.4.3（2026-11-11 17:22 服务器本机时间）：`docker build -t hivemem:0.4.3`；19189 用生产库 VACUUM INTO 快照冒烟，MCP 实测 `serverInfo.version=0.4.3`、9 工具 required 如上、无 project 调用 isError、带 project 检索/stats 正常；备份 `docker-compose.yml.bak-20261111-172202-pre043` + `data/backup/hivemem-pre-043-20261111-172202.db`，切 tag 后 healthy/Restarts=0，线上 386 条 / 40 项目，公网 200

**已知遗留**：插件代码已随 hardlink 落盘，但 dsh web host 进程启动时已 import 旧模块，需重启宿主才会用上新 `briefHeader`；按约定不代用户重启。

## Phase J（v0.4.4）：用户级记忆可按 id 跨项目寻址

来源：新会话首轮 `memory_read` 报 `MEMORY_NOT_FOUND`——id 取自简报「用户级记忆」段（`mem_67d11830b56e4962a359`），但用户从未删除。根因：用户级记忆物理存放在保留项目 `@user`（单用户 `prj_user`，多用户每人一行），而 `memory_read` 走 `requireMemory` 的 `m.project_id !== projectId` 硬匹配；简报与 `memory_search` 都把用户级行带进每个项目，唯独按 id 的工具没有回退——「看得见、读不到」的语义缺口。

- [x] J1 寻址层：新增 `store.requireMemoryForProject(db, projectId, id, userProjectId)`，命中条件为 `project_id === projectId` 或 `project_id === 调用者自己的 @user`；跨用户 `@user` 与跨项目行仍然 `MEMORY_NOT_FOUND`（项目隔离不变）
- [x] J2 工具接线：`memory_read` / `memory_update` / `memory_archive` / `memory_review`(mark_reviewed) 先解析，再以行的真实 `project_id` 落库——SQL `WHERE project_id = ?` 守卫与审计不会被工作区 id 污染；变更后同时通知工作区与 `@user` 两个简报
- [x] J3 测试：MCP 用例覆盖 workspace 视图 read/update/archive 用户级记忆 + 项目记忆仍隔离；store 用例覆盖跨用户 `@user` 仍拒绝；`npm test` 100/100、`check:plugin` 15/15、typecheck/build 干净
- [x] J4 线上部署 v0.4.4（2026-11-13 20:11 服务器本机时间）：构建上下文就地改 5 个文件（store.ts / mcp.ts / index.ts / package.json / package-lock.json），LF 归一化后与本地 sha256 全等；`docker build -t hivemem:0.4.4`；19288 全新库冒烟——`serverInfo.version=0.4.4`、用户级记忆在 workspace 视图 read OK / update v2 / archive archived、项目记忆跨项目仍 `MEMORY_NOT_FOUND`；19289 生产库快照冒烟——多用户模式、无令牌 401、库打开无迁移错误；备份 `docker-compose.yml.bak-20261113-201159-pre044` + `data/backup/hivemem-pre-044-20261113-201135.db`；切 tag 后 healthy / Restarts=0；线上 MCP 实测 `memory_read(project="HiveMem-MCP", id="mem_67d11830b56e4962a359")` 返回 `scope=user`，公网 200、无令牌 401