# HiveMem

[![CI](https://github.com/zp96324511/HiveMem-MCP/actions/workflows/ci.yml/badge.svg)](https://github.com/zp96324511/HiveMem-MCP/actions/workflows/ci.yml)

**以项目为单位的多 agent 共享记忆中枢。** 一个 SQLite 库、9 个 MCP 工具、一个内置 Web 管理平台——让 Claude Code、Cursor、Cline、Codex 等任意 agent 工具共享同一份项目记忆。

```
Claude Code ─┐                        ┌─ SQLite (WAL) ~/.hivemem/hivemem.db
Cursor ──────┼─ MCP (stdio 或 HTTP) ─→│  HiveMem hub
Cline ───────┤   + Web 管理平台       ├─ FTS5 全文检索（中文友好）
任意 agent ───┘   http://127.0.0.1:7660 └─ 审计日志
```

## 特性

- **项目身份锚定文件系统**：项目根目录的 `.hivemem/project.json` marker 让身份跨会话、跨工具、跨路径稳定；agent 从任意子目录访问都能自动归并到同一项目
- **四层记忆作用域**：用户级（`@user`，跨项目身份/偏好，简报最优先加载）→ 项目级 → 设备级（同项目跨机器环境差异）→ 工具级（同项目同设备跨 agent 配置差异）；检索默认跨作用域并标注来源层
- **9 个 MCP 工具**：bootstrap 简报 / 写入 / 检索 / **索引** / 读取 / 更新 / 归档 / 复审 / 统计——工具面刻意保持精简，agent 才会用
- **记忆可管理**：内置 Web 管理平台（v0.3 层次化重设计：作用域树导航、分层分组浏览、记忆详情抽屉含演进链与复审、简报预览、统计与设备注册表、审计日志、多用户管理、项目删除（级联清理，可一并移除目录 marker））
- **双运行模式**：`serve`（stdio，agent 客户端本地拉起）与 `hub`（HTTP 常驻中枢，多 agent 共享 + Web 管理）
- **混合检索**：FTS5 trigram 全文（中文友好）+ 可选语义向量（任意 OpenAI 兼容嵌入端点），换模型有三态身份校验与 `repair-embeddings` 重建
- **记忆生命周期**：TTL 过期自动归档（`gc`）、`supersedes` 决策演变链（旧版自动标记、链式可查）、审计快照
- **并发不互相覆盖**：每条记忆带 `version`，写入用 `expected_version`（HTTP `If-Match`）做乐观并发；冲突报 `REVISION_CONFLICT` 并回带当前版本，agent 重读再改而不是盲写
- **版本可寻址**：每次修改把变更前的完整行存进 `memory_revisions`，`memory_read(at_version=N)` / `GET /api/memories/:id?at_version=N` 能拿到那一版的原话——记忆删掉了也还能读
- **证据链**：写入可带 `evidence`（`{kind, locator, quote?}`，kind 为 prompt/session/file/url/command/artifact/note），`locator` 是会话轮次或 `文件:行`，让「这条结论从哪来」可复核而不只是可解释
- **前置注入（可选）**：`dsh-plugin/` 让 DSH 在每次模型步骤前自动注入项目简报，不再依赖模型自觉调用 `memory_bootstrap`；只读 `/api/brief`，失败即放行
- **简报自解释**：截断不静默——每条带版本号、被裁的条目自带标记、页脚拆分「预算放不下」与「名额没进」两种缺失原因、用户级那层被裁也单独说明；`/api/brief?budget=N` 让宿主按自己的 prompt 预算取文，服务端保证 `rendered ≤ budget`
- **会话导入**：`import-claude` 一键把 Claude Code 的 JSONL 会话史变成 episodic 记忆（幂等、保留原始时间戳）
- **hub 认证**：`hivemem token` 生成 Bearer 令牌，`/mcp` 与 `/api` 全程 timing-safe 校验
- **零原生依赖**：基于 Node 内置 `node:sqlite`，`npx` 即用，无需编译
- **并发安全**：WAL + busy_timeout，多个 agent 进程可同时读写
- **审计日志**：每次创建/更新/删除/取代/过期/移动都记录操作者与旧值快照

## 快速开始

需要 Node.js >= 24。

### 模式一：hub（推荐，多 agent 共享）

```bash
npx hivemem-mcp hub            # 或本地: node dist/index.js hub
```

启动后：

- **管理平台**：http://127.0.0.1:7660/ （搜索、编辑、管理记忆条目）
- **MCP 端点**：`http://127.0.0.1:7660/mcp`
- **REST API**：`http://127.0.0.1:7660/api/*`

各 agent 客户端配置（HTTP 模式，工具调用时传工作区路径作为 `project`）：

```json
{
  "mcpServers": {
    "hivemem": { "url": "http://127.0.0.1:7660/mcp" }
  }
}
```

### 模式二：stdio（单 agent 本地）

Claude Code / Cursor / Cline 等 stdio 客户端配置：

```json
{
  "mcpServers": {
    "hivemem": {
      "command": "npx",
      "args": ["-y", "hivemem-mcp", "serve"],
      "env": { "HIVEMEM_AGENT": "claude-code" }
    }
  }
}
```

stdio 模式下项目从当前工作目录自动解析，无需传 `project` 参数。`HIVEMEM_AGENT` 环境变量标识写入者（进审计日志）。

## MCP 工具

| 工具 | 用途 |
|---|---|
| `memory_bootstrap` | 获取分层简报：**用户级记忆（跨项目）优先加载**，然后置顶记忆 + 关键决策 + 关键事实/偏好/流程 + **最近更新索引**，最后本设备/本工具记忆索引；可传 `task_hint` 让简报优先附上任务相关记忆。**上下文里已有「## HiveMem 项目简报（自动注入 · project=…）」段落时不要调用**（宿主插件已注入，再调只会重复），只在没装插件或要看别的项目时用。简报是**策展视图**：每行带 `v{version}`（可直接带 `expected_version` 写回），单条正文被裁时该条自己标「（已截断）」，覆盖不全时 `truncated=true` 并附页脚：共 N 条 / 列出 M 条 / **缺的 M−N 条按原因拆分**（`预算 k 条` vs `名额 j 条`）+ 全量索引指针；机器可读的同一份计数在 `omitted: {budget, priority}`（相加恰为 `total − shown`）；用户级那层属于 `@user` 项目、不进 `total`，被裁时另有「用户级记忆 N 条中列出 M 条」一行与 `userLevel: {total, shown}`；`budget` 参数（512..8000，默认 2600）让宿主按自己的 prompt 空间取文，服务端保证 `rendered.length ≤ budget` |
| `memory_index` | 枚举记忆清单（标题级，分页）：`total` 永远是**匹配总数**（不是本页条数），`next_offset` 指向下一页；可按 `kind`/`scope` 过滤、按 `updated`/`importance`/`title` 排序。用于盘点存量、写入前查重、或简报被截断后拉全量 |
| `memory_write` | 写入记忆（`scope` 可选 user/project/device/agent 四层）；`topic_key` 同 key 原地修订（revision_count +1），`supersedes` 取代旧记忆成链，`ttl_days` 设有效期；`evidence` 累积证据链；修订可带 `expected_version` 做乐观并发（冲突报 `REVISION_CONFLICT`） |
| `memory_search` | 混合检索（FTS5 + 语义 + 新近度 + 重要性 + 置顶加权），默认搜当前项目全部作用域 + 用户级记忆，命中带 `scope` 标注；query 可省略浏览最近 |
| `memory_read` | 按 id 读全文；属于取代链时返回完整链（旧→新）；`at_version=N` 读历史快照，`include_history` 同时返回版本列表 |
| `memory_update` | 部分字段更新（写入修订快照）；`expected_version` 做乐观并发；`evidence` 为上送全量替换；传 `scope` 可跨作用域迁移 |
| `memory_archive` | 归档（退出检索但保留历史）；同样支持 `expected_version` |

| `memory_review` | 复审周期：列出 `review_after` 到期的记忆，或标记已复审（周期按 kind 重新起算） |
| `memory_stats` | 项目统计（kind/status/scope 分布）/ 全部项目列表 |

**MCP Resource**：`memory://projects/{projectId}/brief` —— 项目简报以资源形式暴露（markdown），记忆变更时发送 `resources/updated` 通知；DSH 的 `dsh-mcp-resources` 可原生发现和读取。另有 `memory://projects/{projectId}/index` —— **全量标题索引**（最多 500 条），简报被截断时按需拉取；资源 URI 不支持 query（模板整串匹配），过滤与分页走 `memory_index` 工具。

**记忆演化两种模式**：一次性结论用 `supersedes`（新旧并存成链，可追溯）；持续演化的主题（"当前部署方式"、"认证方案"）用 `topic_key`（原地修订不产生重复，revision_count 记录版本）。

**复审周期**（到期标记 `needsReview`，内容仍可见，不隐藏不删除）：preference 90 天 / fact、decision 180 天 / procedure 365 天；episodic/snippet 无复审（episodic 走 TTL）。

## 记忆类型（kind）

| kind | 含义 | 典型内容 |
|---|---|---|
| `decision` | 技术决策及理由 | "选 SQLite 因为零运维" |
| `fact` | 项目事实 | "构建入口是 src/index.ts" |
| `preference` | 用户偏好 | "回复用中文" |
| `procedure` | 操作流程 | "发布前跑 pnpm test" |
| `episodic` | 会话过程 | "今天修了登录超时 bug" |
| `snippet` | 代码/位置引用 | "关键逻辑在 auth.ts:120" |

## 记忆作用域分层

记忆按四层作用域组织（设计与取舍详见 [DESIGN.md](DESIGN.md) §13）：

| 层 | scope | 内容 | 例 |
|---|---|---|---|
| 用户级 | `user` | 跨项目的身份、能力、偏好 | 微信通知 API、称谓、开发习惯 |
| 项目级 | `project`（默认） | 项目知识 | 技术决策、项目事实 |
| 设备级 | `device` | 同项目在不同机器的环境差异 | X 机 JDK 在 `D:\`，Y 机在 `/opt` |
| 工具级 | `agent` | 同项目同设备在不同 agent 工具的配置差异 | ZCODE 用 2 skill+3 MCP，DSH 用 1 skill+6 MCP |

- **写入**：`memory_write` 传 `scope`；设备/工具名取自请求上下文（`X-HiveMem-Device` 头，缺省回退主机名；`X-HiveMem-Agent` 头），不手输——防碎片化。`scope=agent` 无工具身份时显式报错，绝不静默降级
- **简报**：用户级最优先（每个项目简报都带）→ 项目级 → 本设备 → 本工具；空段自动跳过
- **检索**：默认全作用域 + 命中标注 `scope`（在 Linux 上看到"win10 的 JDK 路径"也知道不适用）；`scope` 参数可过滤
- **迁移**：`memory_update` 传 `scope` 跨层迁移（发现设备记忆实为通用知识时上提）
- **设备注册表**：首次见到即自动登记（`GET /api/devices`），web 统计页可见

## 项目身份与引用

**身份**：项目根的 `.hivemem/project.json`（随机 UUID）。**marker 随仓库提交**——clone 到任何机器、任何路径都解析到同一项目身份（git 传输身份，与路径无关）。同机多路径访问自动归并；不想跨 clone 统一身份可把 `.hivemem/` 加进 `.gitignore`。

**引用**（`project` 参数）：**项目名是 agent 的首选引用**——短、稳定、可读。解析顺序：项目名（大小写不敏感）→ 项目 id → 工作区绝对路径（仅用于首次注册新目录）。名称唯一性由系统保证：路径注册撞名自动加后缀（`api` → `api-2`），遗留重名数据名称引用会报 `AMBIGUOUS_PROJECT` 歧义错误（绝不静默选一个），可用 `PATCH /api/projects/:id` 重命名。

**删除项目**：管理面板项目节点上的 ✕，或 `DELETE /api/projects/:id?confirm=<项目名>`（非空项目必须回传项目名，防止误删级联）。删除会一并清掉该项目的全部记忆（含设备级/工具级）、向量、路径别名与授权关系，审计日志保留一条 `project_delete` 记录；仅项目所有者与管理员可删，`@user` 是保留项目不可删。带 `&remove_marker=1` 时顺带删除目录里的 `.hivemem/project.json`——hub 看不到客户端目录时（中心化部署）需要在该机器上手动删除，否则下次以该路径引用会重新注册同名项目（记忆为空）。

**新项目零摩擦接入**：agent 以新项目名调用一次 `memory_bootstrap` 即自动创建（响应含 `created: true` 与既有项目列表，供 agent 当场核对笔误）；写/检索工具对未知名称仍严格报 `PROJECT_NOT_FOUND`，防止拼写错误静默碎片化。中心化部署下 hub 看不到客户端文件系统，路径自动注册不可用——bootstrap 的按名自动注册就是它的等价物。

**跨机器共享记忆**：身份统一后，把两台机器的 agent 都指向同一个 hub（如 `--host 0.0.0.0` + `HIVEMEM_TOKEN`，另一台机器的 MCP 配置填 `http://<hub机器>:7660/mcp` + Bearer 头）即可共用一份记忆库；各自跑本地 hub 则各持一份库（身份一致，数据分开）。

## 项目隔离与审计

- 服务器指令明确要求 agent **只访问当前工作区对应的项目**，跨项目读写需用户明确要求
- HTTP 模式下全部工具（含 stats）都要求显式 project；**非绝对路径的引用直接拒绝**（防止乱传字符串静默落到其他项目）
- `memory_read` / `memory_bootstrap` 记入审计（`read` / `bootstrap` 动作）——谁在什么时候读了哪个项目的什么，管理平台审计页可见

## 前置注入（DSH 插件，可选）

工具调用是模型的选择，注入是宿主的事实。`dsh-plugin/` 让 DSH 在**每次模型步骤前**自动把项目简报放进上下文，不再依赖模型自觉调用 `memory_bootstrap`：

```powershell
# 1) 从 GitHub release 装进 DSH profile（包自带的 bundle patch 会自动注册 hivemem-brief）
dsh plugin --profile web add https://github.com/zp96324511/HiveMem-MCP/releases/latest/download/hivemem-dsh.tgz

# 2) 在 profile 的 cordis.patch.yml 里覆盖默认配置（默认连 http://127.0.0.1:7660，且不带 token）
# - id: hivemem-brief
#   config:
#     baseUrl: https://hivemem.zpzp.xyz
#     token: <你的 MCP 令牌>
#     device: <本机设备名>        # 不写则用系统主机名

# 3) 重启 dsh web 后验证：会话里应出现「## HiveMem 项目简报（自动注入）」段
```

`dsh plugin add` 会自己把包追加进 `dsh.profile.bundles`，不需要手写 `insert`。升级时用**带版本号**的 URL（`releases/download/v0.5.0/hivemem-dsh.tgz`）重新 add；`latest/download` 的 spec 不变，pnpm 会跳过解析、装不到新版本。

- **只读**：插件只调 `GET /api/brief`，从不写库——记忆的产生仍然只走 agent 策展路径
- **不重复取**：注入的段落自带一句「简报已经在这里了，不必再调用 `memory_bootstrap`」，MCP 的 `SERVER_INSTRUCTIONS` 与工具描述也改成了条件式（先看有没有注入段，有就不调），避免模型在同一步里白拿第二份
- **失败即放行**：1.5s 超时、TTL 60s 缓存、单飞去重；hub 不可达时保留上一份简报或干脆不注入，绝不阻塞会话
- **身份**：插件带上 `X-HiveMem-Device`（默认系统主机名，可用 `device`/`HIVEMEM_DEVICE` 覆盖）与 `X-HiveMem-Agent`（默认 `dsh`），本设备/本工具两层记忆才会出现在简报里
- **缺失可见**：项目未注册时注入一行「本项目「X」尚未注册，未注入简报。需要时调用 `memory_bootstrap(project="X")`」，而不是静默空串——模型下一步就能补，人看 system prompt 也能发现
- **不二次裁剪**：插件按 `maxChars − 头部` 向服务端要预算（`?budget=`），服务端按该预算出文；若仍超出（例如 `maxChars` 低于服务端 512 下限），注入一行「超出注入预算，已跳过正文」的提示并告警，绝不从尾部切——切掉的是服务端自己的「已截断」页脚，那正是读者唯一能知道少了东西的地方
- **项目解析**：默认取会话 cwd 的目录名（与 HiveMem 的项目命名约定一致），可用 `project` 配置写死
- **不用插件的场合**：`hivemem brief --project X` 打印同一份简报（markdown，`--url` 走远程 hub 并同样带设备/工具头），可手工粘进任意 agent 的上下文；`memory://projects/{id}/brief` 资源是第三种通道

完整说明见 [dsh-plugin/README.md](dsh-plugin/README.md)。

## hub 常驻运行（Windows）

`scripts/start-hub.cmd`（从 `start-hub.cmd.example` 复制并填入嵌入配置；含密钥已被 gitignore）启动 hub 并把日志追加到 `hub.log`。**不要在会话型终端里直接 Start-Process**——沙箱会话结束时子进程可能被回收；用任务计划程序：

```powershell
# 仓库根目录（换成你的 clone 路径）
$repo = 'C:\path\to\HiveMem-MCP'

# 注册并立即启动（进程归属 Task Scheduler 服务，跨会话存活）
$action = New-ScheduledTaskAction -Execute "$repo\scripts\start-hub.cmd" -WorkingDirectory $repo
Register-ScheduledTask -TaskName 'HiveMemHub' -Action $action -Trigger (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5)) -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero)) -Force
Start-ScheduledTask -TaskName 'HiveMemHub'

# 开机自启：启动文件夹放隐藏启动器（无需管理员）
# C:\Users\<user>\...\Startup\hivemem-hub.vbs:
#   CreateObject("WScript.Shell").Run """<repo>\scripts\start-hub.cmd""", 0, False

# 停止 / 重启
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'index\.js hub' } | ForEach-Object { Stop-Process -Id $_.ProcessId }
Start-ScheduledTask -TaskName 'HiveMemHub'

# 日志
Get-Content .\hub.log -Tail 20 -Wait
```

## 服务器部署（1Panel / Docker）

v2 起支持容器化中心部署：多阶段 Dockerfile（node:24-alpine）+ compose 编排，经 OpenResty 反代 + 通配符证书对外提供 HTTPS。当前生产部署：**https://hivemem.zpzp.xyz**（1Panel 编排 `hivemem`，多用户模式）。完整方案与实操记录见 [DEPLOY-1PANEL.md](DEPLOY-1PANEL.md)。

要点：

- 容器内 `--host 0.0.0.0`，宿主侧仅绑 `127.0.0.1:<port>`，公网唯一入口是反代 443
- 数据卷 bind mount + `HIVEMEM_DB=/data/hivemem.db`；每日 `VACUUM INTO` 在线快照备份（不停服）
- **中心化后客户端必须显式配置 `X-HiveMem-Device`**——hub 端的主机名回退会解析成服务器主机名，所有客户端的设备级记忆会挤到同一个错误设备名下
- 多用户引导：`docker exec hivemem node dist/index.js user add <name> --password <pw>`（首用户强制 admin 并认领全部项目）；`hivemem setup --agent dsh --url https://<域名>/mcp --token <令牌> --device <设备名>` 一条命令切换客户端

## 命令行

```bash
hivemem serve              # stdio MCP server（默认）
hivemem hub --port 7660    # HTTP 记忆中枢 + Web 管理平台
hivemem status             # 查看数据库与项目统计（含向量索引状态）
hivemem token              # 生成 Bearer 访问令牌（hub 认证用）
hivemem gc                 # 清扫过期记忆（TTL 到期的归档；hub 启动时也会自动执行）
hivemem brief [--project REF] [--url HUB] [--json]   # 打印项目简报（--url 走远程 hub；手工/脚本预览，不适配宿主时用它）
hivemem import-claude SRC --project REF   # 导入 Claude Code 会话 JSONL（幂等，报告不可读行）
hivemem repair-embeddings [--force]       # （重）建向量索引；换嵌入模型后必须执行
hivemem setup --agent dsh                 # 把 HiveMem 写入本地 DSH 的 MCP 配置（幂等）
hivemem doctor                            # 健康检查：数据库 / hub / MCP 端点 / 嵌入索引 / agent 配置
hivemem --db PATH ...      # 自定义数据库路径（或 HIVEMEM_DB 环境变量）
```

## 语义检索（可选）

设置环境变量即可启用，任意 OpenAI 兼容端点均可（URL 传 base 或完整 `/embeddings` 端点都行）：

```bash
HIVEMEM_EMBEDDING_URL=http://your-host:port/v1/embeddings \
HIVEMEM_EMBEDDING_MODEL=bge-large \
HIVEMEM_EMBEDDING_KEY=<your-key> \
hivemem hub
```

- 检索变为混合模式：**先语义准入，再排名融合（RRF）**，元数据只做同分 tie-break
  - 语义准入：绝对余弦下限 `HIVEMEM_SEMANTIC_MIN_SCORE`（默认 `0.40`，按模型族标定）+ 相对本次最高分截断 `HIVEMEM_SEMANTIC_MARGIN`（默认 `0.12`）。低于门槛的向量不进入结果；纯词法命中不受此限
  - 融合分 `score = 5·(1/(10+语义名次) + 1/(10+词法名次))`：两路都第一 = 1.0，单路第一 = 0.5；`score` 只在本次查询内可比
  - 命中字段：`relevance` 是绝对相关性（语义余弦原值，纯词法命中为 `null`）；`matched` 标明 `semantic` / `lexical` / `both`；`total` 是过门槛后的命中数，`scanned` 是参与比较的向量数
  - **换嵌入模型后需重新标定门槛**（不同模型余弦分布差异很大：bge 系无关文本常在 0.3–0.45，OpenAI 系常在 0.0–0.2），用 `hivemem doctor` 或抽样查看分布后调整
- **换模型不会静默降质**：库内记录嵌入模型身份，不一致时自动降级为词法检索并在结果中给出警告；`hivemem repair-embeddings` 重建索引后恢复
- **短上下文模型安全**：送入嵌入的文本默认截断到 480 字符（bge 系列 512 token 上限的安全值，标题在前保主旨）；长上下文模型可用 `HIVEMEM_EMBEDDING_MAX_CHARS=6000` 放宽
- **预算模式**：`HIVEMEM_SEMANTIC_MODE=fallback` 时只在词法检索无命中才调用嵌入端点（按量计费/不稳定端点省钱）
- 未配置时一切功能照常（纯词法），嵌入失败不影响记忆写入

## hub 认证（可选）

```bash
hivemem token              # 生成 64 位十六进制令牌
HIVEMEM_TOKEN=<token> hivemem hub
# 或 --token-file PATH
```

启用后 `/mcp` 与 `/api/*` 要求 `Authorization: Bearer <token>`（timing-safe 比较）；Web 管理平台打开时提示输入令牌并保存在 localStorage。不启用时仅绑定 127.0.0.1，请勿暴露公网。

## 多用户权限（可选，v2）

默认**单用户模式**（与从前完全一致，零迁移成本）。创建首个用户即启用多用户模式——该用户成为平台管理员并认领全部已有项目：

```bash
hivemem user add boss --password <密码>     # 首个用户 → 强制 platform-admin，认领全部无主项目
hivemem user add boss --adopt-env-token    # 顺带把现有 HIVEMEM_TOKEN 接管为该用户的 MCP 令牌（DSH 配置无需改动）
hivemem user add alice --password <密码>   # 普通用户
hivemem user token alice                   # 为 alice 生成 MCP 访问令牌（明文只显示这一次）
hivemem user list                           # 用户列表；另有 user passwd <name> 改密
```

- **角色**：`platform-admin` 读写管理任意用户记忆 + 授予/撤销跨用户只读授权；普通用户只能读写自己的项目 + 只读被授权的项目
- **凭证分离**：MCP 客户端用每用户 Bearer 令牌（库存 SHA-256 哈希，吊销即时生效）；Web 管理平台用用户名 + 密码登录（scrypt），session cookie HttpOnly+SameSite=Lax，改密码使该用户全部会话失效
- **授权粒度 = 项目**：管理平台「用户管理」页或 `POST /api/grants`（仅管理员）；受权项目只读（写 403）、撤销即时生效；条目级授权被刻意否决（混合检索后按行过滤权限复杂度爆炸）
- **每用户独立 @user**：多用户模式下用户级记忆按用户隔离（项目名唯一性按 owner 计）
- **隔离保证**：非管理员的名称解析、项目列表、全局检索、错误提示均不泄露他人项目（按 id 访问未授权项目返回 403）
- **DSH 每用户配置**（各用户在自己的 profile 里放自己的 token；可用 `hivemem setup --agent dsh --token <token> [--device <name>]` 自动写入或为已有条目补头）：

```yaml
- insert:
    - id: mcp-hivemem
      url: http://127.0.0.1:7660/mcp
      headers:
        Authorization: Bearer <该用户的 token>
        X-HiveMem-Agent: dsh
        X-HiveMem-Device: <设备名，缺省回退主机名>
```

- **⚠️ 部署安全**：多用户 = 网络暴露，HTTP 明文令牌在局域网可被嗅探——多用户部署必须保持 localhost + 反向代理 TLS，或走 Tailscale 类隧道，否则权限模型形同虚设

## 开发

```bash
npm install
npm run build     # tsc + 复制 web/
npm test          # 全量测试（node:test）：项目身份 / 存储检索 / MCP 往返 / 生命周期 / 嵌入 / 导入 / 认证 / 作用域分层 /
                  # 版本与并发 CAS（test/revisions.test.ts）/ 前置注入插件（test/dsh-plugin.test.ts）/
                  # 端到端验收（test/acceptance.test.ts：真进程写入 → 新进程召回 → 注入 → CLI，约 9s）
npm run check:plugin  # dsh-plugin 纯逻辑单测（node --test，无需装进宿主）
npm run dev:hub   # 开发模式启动 hub
```

端到端验收是刻意做成「真子进程」的：`test/acceptance.test.ts` 起两个独立 MCP 进程 + 一个 hub，验证的是**跨进程、跨会话的真实召回**，而不是同一个内存对象上的函数返回值——后者永远证明不了会话边界上的问题。

架构与设计决策详见 [DESIGN.md](DESIGN.md)。

## 路线图

- [x] ~~嵌入向量检索（可插拔 provider，含模型身份三态校验）~~ P2 已完成
- [x] ~~TTL 过期归档（gc）~~ P2 已完成
- [x] ~~Claude Code 会话日志导入~~ P2 已完成
- [x] ~~hub Bearer token 认证~~ P2 已完成
- [x] ~~supersedes 决策演变链~~ P2 已完成
- [x] ~~topic_key 原地 upsert + 复审周期 + memory_review~~ P3 已完成（借鉴 Engram）
- [x] ~~相似记忆提示 + Resource 简报 + 变更通知~~ P3 已完成（借鉴 MCP Reference Memory）
- [x] ~~task_hint 任务透镜 + 语义 fallback + setup/doctor~~ P3 已完成（借鉴 Memorix）
- [x] ~~四层记忆作用域：用户级（@user）/ 项目级 / 设备级 / 工具级~~ v2-A 已完成
- [x] ~~多用户权限：用户隔离、跨用户只读授权（项目粒度）、web 登录~~ v2-B 已完成
- [ ] LLM 辅助整合（会话末去重/合并，确定性尺寸兜底优先）
- [ ] Codex / Cursor 会话日志导入
- [ ] npm 发布（发布后 `npx hivemem-mcp` 即用）

## License

MIT
