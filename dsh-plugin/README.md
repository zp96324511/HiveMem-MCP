# hivemem-dsh

DSH 插件：在**每一步模型请求之前**把当前项目的 HiveMem 简报注入上下文，让「新会话自动带着项目记忆」不再依赖模型自觉调用 `memory_bootstrap`。

包根目录也是 HiveMem 仓库的 `dsh-plugin/`，与主包共用一个版本号。

## 它解决什么

HiveMem 原来的召回是「按需工具」模型：`memory_bootstrap` 摆在工具表里，调不调取决于模型。PowerContext 的做法相反——宿主在每步之前把准备好的上下文塞进请求。本插件给了 HiveMem 同样的通道，但保留确定性：注入的只是**已有记忆的渲染结果**，不抽取、不生成、不调模型。

- 注入点：`agent/pre-step`（异步读取 `GET /api/brief`）+ `systemPrompt.context`（同步取缓存文本）。
- 预算：`maxChars` 是**整个注入块**的上限。插件按「`maxChars` − 头部」向服务端要预算（`?budget=`，服务端夹在 512..8000），**自己从不裁剪**——服务端保证 `rendered ≤ budget`，插件只做校验。
- 不重复取：注入段落头部写明「简报已经在这里了，不必再调用 `memory_bootstrap`」，配合 MCP 侧改成条件式的 instructions 与工具描述，避免同一步里拿第二份。
- 身份：带 `X-HiveMem-Device` / `X-HiveMem-Agent`，本设备/本工具两层记忆才会被 hub 选进简报（缺省时 hub 会用自己的主机名，等于静默丢两层）。
- 缺失可见：项目未注册（404 `PROJECT_NOT_FOUND`）时注入一行「本项目尚未注册，需要时调 `memory_bootstrap`」；简报超出 `maxChars` 时注入一行「超出注入预算，已跳过正文」。两种情况都不阻塞请求。
- 失败即放行：hub 不可达、超时、JSON 异常 → 本轮不注入，**不阻断请求**；刷新失败时保留上一次成功的文本。
- 每 TTL（默认 60s）最多一次读取，同项目并发刷新只发一个请求。

## 安装

### 从 GitHub release 装（推荐）

```powershell
dsh plugin --profile web add https://github.com/zp96324511/HiveMem-MCP/releases/latest/download/hivemem-dsh.tgz
```

`dsh plugin add` 会把包追加进 `dsh.profile.bundles`，包自带的 `dsh.bundle.patch` 随后插入 `hivemem-brief`；默认连本机 `http://127.0.0.1:7660`、不带 token。

接远程 hub 或多用户模式时，在 profile 的 `cordis.patch.yml` 顶层覆盖同 id 的配置（patch 层顺序 bundle → profile，且 `config` 是整体替换）：

```yaml
- id: hivemem-brief
  config:
    baseUrl: https://hivemem.zpzp.xyz
    token: <你的 MCP 令牌>
    device: <本机设备名>          # 省略 = 系统主机名
```

重启 dsh Web Host 后生效。

**升级**：用**带版本号**的 URL 重新 add，例如 `.../releases/download/v0.4.4/hivemem-dsh.tgz`。`latest/download` 的 spec 不变，pnpm 会跳过解析、装不到新版本。

### 本地开发（file: 安装）

```powershell
# npm 的 file: 会建符号链接（改代码立即生效）；pnpm 是拷贝（改完要重装一次）
pnpm --dir $env:USERPROFILE\.dsh\profiles\web add "file:C:\data\projects\HiveMem-MCP\dsh-plugin"
```

`file:` 安装的是目录，版本号不随文件内容变化；升级/对比版本请改用打包产物。

> 重装或升级前先确认当前 profile 的 patch 里没有重复的 `hivemem-brief` 条目：重复 id 会让加载报错。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:7660` | hub 地址；也读 `HIVEMEM_HUB_URL`。自动去掉尾部 `/` 与 `/mcp` |
| `token` | 空 | Bearer 令牌（多用户模式的 MCP 令牌）；也读 `HIVEMEM_TOKEN` |
| `project` | `auto` | `auto` = 会话工作目录名；也可写死项目名（monorepo / 目录名与项目名不一致时） |
| `maxChars` | `2800` | **整个注入块**（头部 + 服务端简报）的字符上限；插件据此换算请求预算，从不自己裁剪。低于服务端 512 预算下限时注入「超出预算」提示 |
| `device` | `auto` | 设备作用域身份；`auto` = 系统主机名（`os.hostname()`），也读 `HIVEMEM_DEVICE`。写错等于看不到本设备那层记忆 |
| `agent` | `dsh` | 工具作用域身份；也读 `HIVEMEM_AGENT`。应与 MCP 配置里的 `X-HiveMem-Agent` 一致 |
| `ttlMs` | `60000` | 缓存有效期；每次 pre-step 最多触发一次刷新 |
| `timeoutMs` | `1500` | 单次 `/api/brief` 读取超时 |
| `contextOrder` | `150` | 在动态上下文里的排序（工作目录 100 之后，harness source 200 之前） |
| `enabled` | `true` | `false` = 不注册任何钩子 |

## 验证

```powershell
# 插件会注入的原文（走本地库，不依赖宿主）
node --import tsx src/index.ts brief --project HiveMem-MCP

# 插件会注入的原文（走远程 hub，和插件同一条路径）
node --import tsx src/index.ts brief --url https://hivemem.zpzp.xyz --token <TOKEN> --project HiveMem-MCP
```

装好插件后，新开会话的第一轮就应该能看到「HiveMem 项目简报（自动注入 · project=…）」这段上下文，且**不需要**任何工具调用。

## 边界

- 注入的是渲染后的记忆文本，不是指令：简报里明确写了「当前用户指示始终优先于这些历史资料」，记忆是背景资料。
- 插件只读 `/api/brief`，不写库——写入路径仍然只有 MCP / REST 两条，避免第二写者。
- 本插件不做记忆抽取或摘要：那会把「记忆」变成模型生成的二手信息，HiveMem 的取舍是策展 + 可复核证据。

## 排障

注入块里出现「本项目「X」尚未注册」且 `X` 明显不是你的目录名时，看第三行「项目名取自会话目录：…」：

- 该行存在 → 目录就是它解析到的那个，改 `project` 配置写死项目名，或把会话开在正确目录。
- 该行缺失、且日志里有 `falling back to …` → 宿主没给出会话目录（工作目录服务未挂载、会话 header 无 `cwd`），回退到了宿主进程目录。此时项目名不可信，应显式配 `project`。

插件的目录解析顺序是：工作目录服务（经 `ctx.reflect` 读取，绕过 `inject` 约束）→ 会话 header 的 `cwd` → 宿主进程目录。

## 卸载

```powershell
dsh plugin --profile web remove hivemem-dsh
```

删掉 profile `cordis.patch.yml` 里覆盖的 `hivemem-brief` 配置，重启宿主即可。删插件不影响任何已存记忆。
