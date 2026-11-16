# HiveMem 1Panel 容器化部署方案

> 状态：**✅ 已执行完成（2026-10-28）**。实际落地与本方案的差异：域名 hivemem.zpzp.xyz、直接多用户模式（admin zp + win10-dsh 设备令牌）、站点 id=22、本地经 127.0.0.1:19180 全链路验证通过。
> 参照：netbird 项目的 1Panel 编排部署模式（compose 目录 + OpenResty 反代 + 通配符证书）。
> 目标：把本地 `127.0.0.1:7660` 的 HiveMem hub 迁移为 `https://hivemem.zpzp.xyz` 的中心化记忆中枢，所有设备/工具的 agent 经 HTTPS + Bearer 接入。

## 0. 目标架构

```
DSH(win10) ─┐                                        ┌─ OpenResty :443 (TLS, *.zpzp.xyz)
ZCODE(win10)─┼─ HTTPS + Bearer + X-HiveMem-Device ──→ │    hm.zpzp.xyz → 127.0.0.1:19180
其他设备 ────┘                                        └─ hivemem 容器 (node:24-alpine)
                                                          SQLite /data/hivemem.db (bind mount)
                                                          嵌入调用 → http://94.103.173.232:10450（bge LXC，DNAT 回环）
```

| 项 | 值 | 依据 |
|---|---|---|
| 服务器 | berohost德国PVE-1panel（94.103.173.232，OneSSH） | 1panel 项目记忆 |
| 编排目录 | `/opt/1panel/docker/compose/hivemem/` | netbird 惯例：目录名=服务名 |
| 容器端口 | 7660（容器内），映射 `127.0.0.1:19180:7660` | 端口规范 19199 递减，19181-19184 已占，**19180 已核实空闲** |
| 站点 | alias=`hivemem`，域名 `hm.zpzp.xyz`，type=proxy，HTTPS | 复用 *.zpzp.xyz 通配符证书（websiteSSLId=2） |
| 镜像 | `hivemem:0.2.0`（本地构建，精确 tag） | 禁 latest 规范；v2 功能落地建议 bump 0.1.0→0.2.0 |
| 数据 | `./data` bind mount → 容器 `/data`（HIVEMEM_DB=/data/hivemem.db） | netbird `./data` 惯例 |

## 1. 决策点（需你确认）

| # | 决策 | 建议 |
|---|---|---|
| D1 | 域名 | **hm.zpzp.xyz**（短；或 hivemem.zpzp.xyz / mem.zpzp.xyz） |
| D2 | 认证模式 | **先 legacy + 单 token**（所有设备共用一个 64hex token，零摩擦）；将来有第二个人用时再 `user add` opt-in 多用户（`--adopt-env-token` 可无缝接管，客户端配置不用改） |
| D3 | 存量数据 | **迁移**：本地 40 条记忆（8 项目，含用户级/设备级/工具级）随 db 一起上服务器 |
| D4 | 本地 hub 去留 | **停用**本地 HiveMemHub 计划任务（避免双写分叉），保留作回滚路径 |
| D5 | 版本号 | bump 到 **0.2.0**（四层作用域 + 多用户 = 里程碑） |

## 2. 镜像构建（Dockerfile，执行阶段加入仓库根）

```dockerfile
# 构建阶段：编译 TS + 复制 web UI
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
COPY scripts ./scripts
RUN npm run build

# 运行阶段：只带 dist
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY package.json ./
# node:sqlite 无原生依赖，无需 npm install（运行时零 node_modules）
USER node
EXPOSE 7660
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7660/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
```

- 基础镜像 `node:24-alpine`（README 要求 Node ≥24；执行时按规范到 Docker Hub 核对确切 tag）
- 需同步加 `.dockerignore`（node_modules、*.log、.git、hub*.log、start-hub.cmd）
- 构建方式：源码打包（git archive 或 tar）→ OneSSH file_transfer 上服务器 → 服务器上 `docker build -t hivemem:0.2.0 .`（无需镜像仓库）

## 3. 编排（docker-compose.yml + hivemem.env）

`/opt/1panel/docker/compose/hivemem/docker-compose.yml`（格式对齐 netbird）：

```yaml
services:
  hivemem:
    image: hivemem:0.2.0
    container_name: hivemem
    restart: unless-stopped
    ports:
      - '127.0.0.1:19180:7660'
    env_file:
      - ./hivemem.env
    volumes:
      - ./data:/data
    command: ["node", "dist/index.js", "hub", "--port", "7660", "--host", "0.0.0.0"]
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:7660/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    logging:
      driver: "json-file"
      options:
        max-size: "500m"
        max-file: "2"
```

`hivemem.env`（chmod 600，含密钥不进 git）：

```bash
HIVEMEM_DB=/data/hivemem.db
HIVEMEM_TOKEN=<执行时生成 64hex>
HIVEMEM_EMBEDDING_URL=http://94.103.173.232:10450/v1/embeddings
HIVEMEM_EMBEDDING_MODEL=bge-large
HIVEMEM_EMBEDDING_KEY=<bge.zpzp.xyz 的 key>
TZ=Asia/Shanghai
```

- `--host 0.0.0.0`：容器内必须全接口监听，端口映射才可达；宿主侧仍只绑 `127.0.0.1:19180`，公网唯一入口是 OpenResty 443
- 嵌入端点走公网 IP（PVE DNAT 回环到 bge LXC，与本地 win10 相同路径，已验证可达）
- healthcheck 打 `/`（Web UI 免认证 200）；启用 token 后 `/api/*` 会 401，不能用作健康检查

## 4. 1Panel API 执行序列（API 优先，全部经 OneSSH exec 在 1panel 主机本地 curl）

鉴权（v2，md5 带 "1panel" 前缀）：

```bash
ts=$(date +%s)
tok=$(printf '1panel<API_KEY>%s' "$ts" | md5sum | awk '{print $1}')
# Header: 1Panel-Token: $tok / 1Panel-Timestamp: $ts
```

| 步 | API | 要点（踩坑清单已消化） |
|---|---|---|
| 1 | （文件写入，非 API） | 先放好 `docker-compose.yml` + `hivemem.env` + `data/`（chown 1000:1000）——**env_file 必须先于编排存在**，否则创建校验失败回滚 |
| 2 | `docker build -t hivemem:0.2.0 /opt/hivemem-build/` | 服务器本地构建 |
| 3 | `POST /api/v2/containers/compose` | body: name=hivemem, from=edit, file=<compose 内容>；创建后 1Panel 编排列表可见（createdBy=1Panel） |
| 4 | `POST /api/v2/containers/compose/operate` | name/path/operation=**up**（首次 up 即生效；以后改端口/映射必须 rebuild） |
| 5 | `POST /api/v2/websites` | type=proxy, alias=hivemem, appType=new, domains=[hm.zpzp.xyz], proxy→127.0.0.1:19180, enableSSL=true, websiteSSLID=2（通配符证书） |
| 6 | `POST /api/v2/websites/proxies/update` | operate=**create**（注意：POST /websites/proxies 是查询端点！）；root 规则 → http://127.0.0.1:19180 |
| 7 | `POST /api/v2/websites/proxies/file` | 微调反代 conf：`proxy_read_timeout 300s`（嵌入调用可能数秒）、`proxy_buffering off`、`client_max_body_size 4m`（hub 请求体上限 2MB，留余量） |
| 8 | 验证 | `curl -s https://hm.zpzp.xyz/api/stats -H "Authorization: Bearer <token>"` |

## 5. DNS 与证书

- **DNS**：`hm.zpzp.xyz` A 记录 → `94.103.173.232`（你的 DNS 面板添加，唯一需要手动的部分）
- **证书**：复用 *.zpzp.xyz 通配符（websiteSSLId=2），无需新申请
- MCP 传输为 streamable HTTP + JSON 响应（`enableJsonResponse: true`），无 SSE 长连接特殊处理，常规反代即可

## 6. 存量数据迁移（D3=迁移时）

```powershell
# 1) 本地停 hub（避免迁移后双写分叉）
Get-ScheduledTask HiveMemHub | Disable-ScheduledTask
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'index\.js hub' } | ForEach-Object { Stop-Process -Id $_.ProcessId }

# 2) WAL checkpoint 后拷贝（只拷主 db 文件，干净）
node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.USERPROFILE+'/.hivemem/hivemem.db');db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close()"

# 3) OneSSH file_transfer 上传到 /opt/1panel/docker/compose/hivemem/data/hivemem.db
# 4) 服务器上 chown 1000:1000 data/hivemem.db（容器内 node 用户可写）
```

迁移后验证：`https://hm.zpzp.xyz/api/stats` 应显示 8 项目 / 40+ 记忆 / byScope 含 user=1 device=1 agent=1。

## 7. 客户端切换（DSH / ZCODE）

`~/.dsh/profiles/web/cordis.patch.yml` 的 mcp-hivemem 条目改为：

```yaml
- insert:
    - id: mcp-hivemem
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: hivemem
        transport: streamable-http
        url: https://hm.zpzp.xyz/mcp
        headers:
          X-HiveMem-Agent: dsh
          X-HiveMem-Device: win10-desk
          Authorization: Bearer <token>
```

**⚠️ 中心化后设备头从"可选"变"必须"**：hub 端的主机名回退会解析成**服务器**的主机名——不配 `X-HiveMem-Device` 的话，所有客户端的设备级记忆会挤到同一个错误设备名下。每台接入设备配自己的设备名（win10-desk / macbook-air / …）。

执行阶段顺手做两件小事：
1. `hivemem setup` 加 `--url` 参数（当前写死 127.0.0.1），支持远程 URL 写入/升级条目
2. ZCODE 接入时同款配置（agent 头 zcode）

## 8. 备份与监控

- **备份**（主机 cron 或 1Panel 计划任务，每日）：
  ```bash
  docker exec hivemem node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/data/hivemem.db');db.exec(\"VACUUM INTO '/data/backup/hivemem-'+new Date().toISOString().slice(0,10)+'.db'\");db.close()"
  ```
  （`VACUUM INTO` = 在线快照，不停服；保留最近 14 份轮转）
- **监控**：容器 healthcheck + 1Panel 容器页自带资源监控；日志 json-file 500m×2 轮转
- 资源占用预估：<100MB 内存、磁盘随记忆线性增长（当前 40 条 <1MB）

## 9. 回滚

- 客户端：patch 条目 url 改回 `http://127.0.0.1:7660/mcp`（token 不变）+ 重载 DSH
- 本地：`Get-ScheduledTask HiveMemHub | Enable-ScheduledTask; Start-ScheduledTask HiveMemHub`
- 注意：迁移点之后两边各自新增的记忆会分叉，回滚时需取舍（可从服务器 db 回拷最新版）

## 10. 执行清单（确认决策点后逐项实施）

- [ ] E1 bump 0.2.0 + Dockerfile + .dockerignore 入库，本地 `docker build` 冒烟（如本机有 docker）或直接服务器构建
- [ ] E2 源码打包 → OneSSH 上传 → 服务器 `docker build -t hivemem:0.2.0`
- [ ] E3 写 `/opt/1panel/docker/compose/hivemem/`（compose + env 600 + data/ 1000:1000）
- [ ] E4 API 建编排 + up；`curl 127.0.0.1:19180` 冒烟
- [ ] E5 DNS A 记录 hm.zpzp.xyz（用户 DNS 面板）
- [ ] E6 API 建站（proxy + SSL websiteSSLId=2）+ 代理规则 + conf 微调
- [ ] E7 存量数据迁移（§6）
- [ ] E8 setup --url 改造 + DSH patch 切换 + 重开会话验证 MCP 工具可用
- [ ] E9 备份 cron 落地 + doctor 远程化验证
- [ ] E10 本地 HiveMemHub 停用；ROADMAP/README 记录部署架构；写项目记忆
