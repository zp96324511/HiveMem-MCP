#!/usr/bin/env node
import path from 'node:path';
import { hostname } from 'node:os';
import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { defaultDbPath, openDb } from './db.js';
import * as auth from './auth.js';
import { createEmbedderFromEnv } from './embedding.js';
import { startHub } from './http.js';
import { importClaudeSessions } from './import.js';
import { createMcpServer } from './mcp.js';
import { resolveProject } from './projects.js';
import { runDoctor, setupDsh } from './setup.js';
import { bootstrapBrief, embeddingStats, projectStats, sweepExpired } from './store.js';
import { reindexEmbeddings, requireEmbedder } from './vec.js';

const HELP = `hivemem 0.4.4 — 项目级多 agent 共享记忆中枢

命令:
  serve              以 stdio MCP server 运行（默认；由 agent 客户端拉起）
  hub                以 HTTP 记忆中枢运行：MCP 端点 + Web 管理平台 + REST API
  status             查看数据库与项目统计
  token              生成一个 Bearer 访问令牌（用于单用户 hub 认证）
  user add NAME      创建用户（首个用户强制 admin 并认领全部无主项目，--adopt-env-token 可接管现有 HIVEMEM_TOKEN）
  user passwd NAME   修改用户密码（--password 或交互输入）
  user list          列出用户
  user token NAME    为用户生成 MCP 访问令牌（明文只显示一次）
  gc                 清扫过期记忆（TTL 到期的 active 记忆归档）
  brief              打印项目简报（接入宿主前的手工预览；--url 走远程 hub）
  import-claude SRC  导入 Claude Code 会话 JSONL（文件或目录），--project 指定目标项目
  repair-embeddings  为全部记忆（重）建向量索引；换嵌入模型后必须执行
  setup              把 HiveMem 写入本地 agent 的 MCP 配置（--agent dsh；幂等；--token/--device 补充请求头）
  doctor             健康检查：数据库 / hub / MCP 端点 / 嵌入索引 / agent 配置

选项:
  --db PATH          数据库路径（默认 ~/.hivemem/hivemem.db，或 HIVEMEM_DB 环境变量）
  --port NUMBER      hub 端口（默认 7660）
  --host ADDR        hub 绑定地址（默认 127.0.0.1）
  --token-file PATH  hub Bearer token 文件（或 HIVEMEM_TOKEN 环境变量；单用户模式）
  --project REF      import-claude / brief 的目标项目（路径/名称/id；brief 省略时用当前目录名）
  --max-chars N      brief 的字符预算（默认 2600；--url 远程读取时按 512..8000 夹取）
  --ttl-days N       import-claude 有效期（默认 90；0 = 永不过期）
  --agent NAME       setup 的目标 agent（当前支持 dsh）
  --token TOKEN      setup 写入的 Bearer 令牌（多用户模式的每用户 token，或单用户模式的 hub token）
  --device NAME      setup 写入的 X-HiveMem-Device 设备名（省略则 hub 用主机名回退）
  --url URL          setup 写入的 hub 地址（默认 http://127.0.0.1:7660/mcp；远程部署用 https://…/mcp）；brief 时表示从该 hub 读取
  --json             brief 输出完整 JSON（默认只打印简报正文）
  --force            repair-embeddings 强制全量重建
  --password PASS    user add / user passwd 的密码（省略则交互输入）
  --role ROLE        user add 的角色（admin|user；首个用户强制 admin）
  --token-name NAME  user token 的令牌备注名（默认 cli）
  --adopt-env-token  user add 时把现有 HIVEMEM_TOKEN 登记为该用户的 MCP 令牌

环境变量:
  HIVEMEM_AGENT              agent 身份（写入审计日志）
  HIVEMEM_EMBEDDING_URL      OpenAI 兼容嵌入端点（启用语义检索）
  HIVEMEM_EMBEDDING_MODEL    嵌入模型名（默认 text-embedding-3-small）
  HIVEMEM_EMBEDDING_KEY      嵌入 API key（可选）
  HIVEMEM_TOKEN              hub Bearer token（单用户模式；创建首个用户后进入多用户模式）`;

async function promptPassword(question: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question}: `)).trim();
    if (!answer) throw new Error('密码不能为空');
    return answer;
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith('-') ? (argv.shift() as string) : 'serve';
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      db: { type: 'string' },
      port: { type: 'string', default: '7660' },
      host: { type: 'string', default: '127.0.0.1' },
      'token-file': { type: 'string' },
      project: { type: 'string' },
      'ttl-days': { type: 'string' },
      agent: { type: 'string' },
      token: { type: 'string' },
      device: { type: 'string' },
      url: { type: 'string' },
      limit: { type: 'string' },
      force: { type: 'boolean' },
      password: { type: 'string' },
      role: { type: 'string' },
      'token-name': { type: 'string' },
      'adopt-env-token': { type: 'boolean' },
      json: { type: 'boolean' },
      'max-chars': { type: 'string' },
      help: { type: 'boolean' },
    },
    allowPositionals: true,
  });

  if (values.help || command === 'help') {
    console.log(HELP);
    return;
  }
  const commands = ['serve', 'hub', 'status', 'token', 'user', 'gc', 'brief', 'import-claude', 'repair-embeddings', 'setup', 'doctor'];
  if (!commands.includes(command)) {
    console.error(`未知命令: ${command}。可用: ${commands.join(' | ')}`);
    process.exitCode = 1;
    return;
  }

  const dbPath = values.db ?? process.env.HIVEMEM_DB ?? defaultDbPath();

  if (command === 'token') {
    const token = randomBytes(32).toString('hex');
    console.log(token);
    console.error('\n用法: 在 hub 启动时设置 HIVEMEM_TOKEN=<token> 或 --token-file；');
    console.error('agent 客户端请求头携带 Authorization: Bearer <token>。');
    return;
  }

  if (command === 'setup') {
    const agent = values.agent?.trim() || 'dsh';
    if (agent !== 'dsh') {
      console.error(`暂只支持 --agent dsh（当前: ${agent}）。其他 agent 请参考 README 手动配置。`);
      process.exitCode = 1;
      return;
    }
    const result = setupDsh({
      port: Number(values.port) || 7660,
      token: values.token?.trim() || undefined,
      device: values.device?.trim() || undefined,
      url: values.url?.trim() || undefined,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'doctor') {
    const report = await runDoctor({ dbPath, port: Number(values.port) || 7660 });
    console.log(JSON.stringify(report, null, 2));
    if (!report.db.ok || !report.hub.ok || !report.mcp.ok) process.exitCode = 1;
    return;
  }

  if (command === 'user') {
    const sub = positionals[0];
    const name = positionals[1];
    const db = openDb(dbPath);
    try {
      if (sub === 'add') {
        if (!name) {
          console.error('用法: hivemem user add <name> [--role admin|user] [--password PASS] [--adopt-env-token]');
          process.exitCode = 1;
          return;
        }
        const password = values.password ?? (await promptPassword(`为用户 ${name} 设置密码（至少 6 位）`));
        const adopt = values['adopt-env-token'] ? (process.env.HIVEMEM_TOKEN?.trim() || undefined) : undefined;
        const { user, token } = auth.createUser(db, {
          name,
          password,
          role: values.role === 'admin' ? 'admin' : 'user',
          adoptToken: adopt,
        });
        console.log(
          JSON.stringify(
            {
              user: { id: user.id, name: user.name, role: user.role },
              ...(auth.userCount(db) === 1
                ? { note: '多用户模式已启用：此用户为平台管理员，已认领全部无主项目' }
                : {}),
              ...(adopt ? { adopted_env_token: true } : {}),
            },
            null,
            2,
          ),
        );
      } else if (sub === 'passwd') {
        if (!name) {
          console.error('用法: hivemem user passwd <name> [--password PASS]');
          process.exitCode = 1;
          return;
        }
        const user = auth.getUserByName(db, name);
        if (!user) {
          console.error(`用户 "${name}" 不存在`);
          process.exitCode = 1;
          return;
        }
        const password = values.password ?? (await promptPassword(`为用户 ${name} 设置新密码（至少 6 位）`));
        auth.setUserPassword(db, user.id, password);
        console.log(JSON.stringify({ ok: true, user: user.name, note: '该用户的全部 web 会话已失效' }, null, 2));
      } else if (sub === 'list') {
        console.log(JSON.stringify({ users: auth.listUsers(db) }, null, 2));
      } else if (sub === 'token') {
        if (!name) {
          console.error('用法: hivemem user token <name> [--token-name N]');
          process.exitCode = 1;
          return;
        }
        const user = auth.getUserByName(db, name);
        if (!user) {
          console.error(`用户 "${name}" 不存在`);
          process.exitCode = 1;
          return;
        }
        const { id, token } = auth.createToken(db, user.id, values['token-name'] ?? 'cli');
        console.log(JSON.stringify({ id, user: user.name, token }, null, 2));
        console.error('\n此明文 token 只显示这一次。配置到 agent 客户端（如 DSH patch）：');
        console.error('  headers: { "Authorization": "Bearer <token>" }');
      } else {
        console.error('用法: hivemem user <add|passwd|list|token> [name]');
        process.exitCode = 1;
      }
    } finally {
      db.close();
    }
    return;
  }

  if (command === 'serve') {
    const db = openDb(dbPath);
    const server = createMcpServer({
      db,
      cwd: process.cwd(),
      httpMode: false,
      agent: process.env.HIVEMEM_AGENT,
      embedder: createEmbedderFromEnv(),
    });
    await server.connect(new StdioServerTransport());
    return; // stay alive serving stdio
  }

  if (command === 'hub') {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error('port 必须是 1~65535 的整数');
      process.exitCode = 1;
      return;
    }
    const token =
      process.env.HIVEMEM_TOKEN?.trim() ||
      (values['token-file'] ? readFileSync(values['token-file'], 'utf8').trim() : undefined) ||
      undefined;
    await startHub({ dbPath, port, host: values.host, token, embedder: createEmbedderFromEnv() });
    return; // server keeps the process alive
  }

  if (command === 'status') {
    const db = openDb(dbPath);
    const stats = projectStats(db);
    console.log(JSON.stringify({ db: dbPath, ...stats, embeddings: embeddingStats(db) }, null, 2));
    db.close();
    return;
  }

  if (command === 'gc') {
    const db = openDb(dbPath);
    const result = sweepExpired(db, 'cli');
    console.log(JSON.stringify(result, null, 2));
    db.close();
    return;
  }

  if (command === 'brief') {
    // Manual fallback for hosts where the injection plugin cannot run, and the
    // fastest way to see the text the plugin would inject: same budget, same
    // renderer, either from a local database or over HTTP from a remote hub.
    const maxChars = values['max-chars'] !== undefined ? Number(values['max-chars']) : 2600;
    if (!Number.isFinite(maxChars) || maxChars < 200) {
      console.error('--max-chars 必须是 >= 200 的数字');
      process.exitCode = 1;
      return;
    }
    const hubUrl = (values.url ?? process.env.HIVEMEM_HUB_URL ?? '').trim();
    if (hubUrl) {
      const base = hubUrl.replace(/\/+$/, '').replace(/\/mcp$/, '');
      const project = values.project?.trim() || path.basename(process.cwd());
      const token = (values.token ?? process.env.HIVEMEM_TOKEN ?? '').trim();
      // Same scope identity the plugin sends, so the preview matches what a
      // session would actually see (device/agent sections included).
      const device = (process.env.HIVEMEM_DEVICE ?? '').trim() || hostname();
      const agent = (process.env.HIVEMEM_AGENT ?? '').trim() || 'dsh';
      // The hub clamps 512..8000 and rejects anything else, so clamp here: a
      // preview at 200 chars would 400 instead of showing a small brief.
      const budget = Math.max(512, Math.min(8000, Math.trunc(maxChars)));
      const res = await fetch(`${base}/api/brief?project=${encodeURIComponent(project)}&budget=${budget}`, {
        headers: {
          accept: 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          'x-hivemem-device': device,
          'x-hivemem-agent': agent,
        },
      });
      if (!res.ok) {
        console.error(`GET ${base}/api/brief?project=${project} → HTTP ${res.status}`);
        process.exitCode = 1;
        return;
      }
      const body = (await res.json()) as { rendered?: string; project?: { id: string; name: string } };
      if (values.json) console.log(JSON.stringify(body, null, 2));
      else console.log(body.rendered?.trim() || '（空简报：该项目尚无记忆）');
      return;
    }
    const db = openDb(dbPath);
    try {
      const project = resolveProject(db, values.project, { cwd: process.cwd(), mode: 'read' });
      const brief = bootstrapBrief(db, project.id, maxChars);
      if (values.json) {
        console.log(JSON.stringify({ project: { id: project.id, name: project.name }, ...brief }, null, 2));
      } else {
        console.log(brief.rendered.trim() || '（空简报：该项目尚无记忆）');
      }
    } finally {
      db.close();
    }
    return;
  }

  if (command === 'import-claude') {
    const src = positionals[0];
    if (!src || !values.project) {
      console.error('用法: hivemem import-claude <jsonl 文件或目录> --project <项目路径/名称/id>');
      process.exitCode = 1;
      return;
    }
    const db = openDb(dbPath);
    try {
      const result = importClaudeSessions(db, {
        src,
        projectRef: values.project,
        ttlDays: values['ttl-days'] !== undefined ? Number(values['ttl-days']) : undefined,
        limit: values.limit ? Number(values.limit) : undefined,
      });
      console.log(JSON.stringify(result, null, 2));
    } finally {
      db.close();
    }
    return;
  }

  // repair-embeddings
  const db = openDb(dbPath);
  try {
    const embedder = requireEmbedder(createEmbedderFromEnv());
    const result = await reindexEmbeddings(db, embedder, { force: values.force });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
