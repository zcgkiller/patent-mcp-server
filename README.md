# Patent Remote MCP Server

一个部署在 **Cloudflare Workers** 上的 remote MCP server，让 Claude（claude.ai / Desktop /
Cowork / mobile 全端）能在对话中实时检索专利数据。第一数据源为 **EPO OPS**（European Patent
Office Open Patent Services），通过 **OAuth 2.1 + Cloudflare Access** 控制访问。

## 暴露的工具（均只读 `readOnlyHint: true`）

| 工具 | 用途 | 主要入参 |
|---|---|---|
| `search_patents` | 按关键词/申请人/分类号检索，返回命中概览 | `query`、`limit`(≤25, 默认10) |
| `get_patent_details` | 取单篇著录项目 + 摘要 | `publication_number`、`format` |
| `get_patent_claims` | 取完整权利要求（分条） | `publication_number`、`format` |
| `get_patent_family` | 取 INPADOC 专利族 + 法律状态 | `publication_number`、`format` |
| `search_patents_google` | Google Patents 引擎高召回/跨术语检索（经 SerpApi） | `query`、`limit`、`country`、`status`、`sort` |

`format` 为 `epodoc`（默认）或 `docdb`。输出统一为清洗后的结构化 JSON。

**何时用哪个检索**：`search_patents` 走 EPO OPS（标题摘要字面匹配，免费、全球书目）；`search_patents_google`
走 Google Patents（自带相关性排序 + 同义/语义扩展，召回高，治术语变体漏检如 siRNA↔"iRNA agent"），
需要 `SERPAPI_KEY`（免费层 250 次/月）。详情/权利要求/同族统一用 OPS 的 `get_patent_*`。
`search_patents_google` 未配置 `SERPAPI_KEY` 时会返回 actionable 提示，不影响其余 4 个工具。

## 架构

```
Claude (MCP client)
   │  OAuth 2.1 (Streamable HTTP)
   ▼
Cloudflare Worker
   ├── @cloudflare/workers-oauth-provider   ← 对 Claude 是 OAuth provider
   ├── 上游身份：Cloudflare Access (SaaS/OIDC)  ← 团队邮箱门禁
   └── createMcpHandler（无状态）→ EPO OPS REST（client-credentials）
   ▼
EPO OPS API (ops.epo.org)
```

- 对 Claude：OAuth provider（Dynamic Client Registration，无需预置 client id/secret）。
- 对 OPS：普通 API client（client-credentials），Worker 持有 consumer key/secret。
- 数据源经 `PatentProvider` 接口抽象（`src/provider.ts`），预留 Google Patents 扩展位。

## 目录

```
src/
├── index.ts        # 入口：OAuthProvider 装配 createMcpHandler + Access
├── mcp.ts          # 4 个工具定义/handler
├── access.ts       # Cloudflare Access 上游 OAuth handler（/authorize、/callback）
├── ops/
│   ├── auth.ts     # OPS client-credentials + token 缓存
│   ├── client.ts   # OPS REST 调用、throttling、重试
│   └── parse.ts    # OPS XML → 结构化 JSON
├── provider.ts     # PatentProvider 接口 + OpsProvider
└── types.ts
```

---

## 部署步骤

### 0. 前置（需自行准备）

1. **EPO OPS 凭据**：在 [EPO Developer Portal](https://developers.epo.org/) 注册应用，拿到
   **Consumer Key + Consumer Secret**。
2. **Cloudflare 账户**，并本地 `npx wrangler login`。
3. **Cloudflare Access for SaaS (OIDC) 应用**（见下「配置 Cloudflare Access」）。

### 1. 安装与本地编译

```bash
npm install
npm run typecheck      # tsc --noEmit，确认编译通过
npx wrangler dev       # 本地起服务（需 .dev.vars，见 .dev.vars.example）
```

### 2. 创建 KV namespace

```bash
npx wrangler kv namespace create OAUTH_KV
```

把返回的 `id` 填入 `wrangler.jsonc` 的 `kv_namespaces[0].id`（替换 `REPLACE_WITH_KV_NAMESPACE_ID`）。

### 3. 注入 secrets（不进 git）

```bash
npx wrangler secret put OPS_CONSUMER_KEY
npx wrangler secret put OPS_CONSUMER_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY      # 用 `openssl rand -hex 32` 生成
npx wrangler secret put ACCESS_CLIENT_ID
npx wrangler secret put ACCESS_CLIENT_SECRET
npx wrangler secret put ACCESS_AUTHORIZATION_URL
npx wrangler secret put ACCESS_TOKEN_URL
# 可选：npx wrangler secret put ACCESS_JWKS_URL
# 可选（启用 search_patents_google）：npx wrangler secret put SERPAPI_KEY
```

> ⚠️ Windows 注意：用 `wrangler secret put` 经 PowerShell 管道注入会在值开头混入 BOM(U+FEFF)，
> 导致 worker 端 URL/解析失败。请改用 git-bash 纯字节注入：
> `printf '%s' '你的值' | node node_modules/wrangler/bin/wrangler.js secret put NAME`

### 4. 部署

```bash
npx wrangler deploy
# → https://patent-mcp-server.<account>.workers.dev
```

### 5. 配置 Cloudflare Access（SaaS / OIDC）

在 Cloudflare Zero Trust 控制台：

1. **Access → Applications → Add an application → SaaS → OIDC**。
2. Redirect URL 填：`https://patent-mcp-server.<account>.workers.dev/callback`
3. Scopes 勾选 `openid`、`email`、`profile`。
4. 保存后得到 **Client ID / Client Secret** 与三个端点 URL
   （Authorization / Token / JWKS，形如
   `https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<app-id>/...`）——
   分别填入第 3 步对应的 secret。
5. 在该应用的 **Access Policy** 里把允许的团队成员邮箱 / 公司域配进去（只有通过的人能连）。

### 6. 验证

**Phase 1（数据链路，可临时用 Access bypass 策略或本地 dev 验证）**

用 [MCP Inspector](https://github.com/modelcontextprotocol/inspector) 连
`https://patent-mcp-server.<account>.workers.dev/mcp`，逐个验证：
`search_patents → get_patent_details → get_patent_claims → get_patent_family`，
用已知公开号（如 `US2025236871A1`）确认能取回 claims，均返回结构化 JSON。

**Phase 2（OAuth）**

在 **claude.ai → 设置 → Connectors → Add custom connector**，填入
`https://patent-mcp-server.<account>.workers.dev/mcp`，走完 Access/OAuth 授权，
确认能 List Tools 并调用。可自然语言提问，如：
> 「查 RBP4 GalNAc siRNA 相关专利的权利要求」

---

## 验收清单

- [ ] MCP Inspector 列出 4 个工具且均能成功调用返回结构化 JSON
- [ ] OPS token 正确缓存（连续多次调用不重复打 auth 端点）
- [ ] 命中 throttling/配额时返回 actionable 错误而非崩溃
- [ ] claude.ai 上作为 custom connector 成功连接并通过 OAuth
- [ ] 自然语言提问能触发工具并返回有效结果

---

## 重要提示

### 🔒 保密性

所有检索 query 与返回数据会经过 **Cloudflare 边缘**。本服务面向 **landscape / 公开专利分析**。
涉及未公开 FTO 思路或精准竞品狙击的高敏感检索，应在调用前将 query **泛化**，或改用自托管链路
（不在本方案范围）。

### ⚖️ OPS 限流

尊重 OPS 的 `X-Throttling-Control`（green/yellow/red）。本实现在 red 状态下短暂退避后单次重试，
配额相关错误返回 actionable 提示而非崩溃，避免触发封禁。

### 🛡️ 最小权限

所有工具只读，不实现任何写/删除能力。

---

## 与 spec 的差异（按 spec「以官方文档为准并记录差异」要求记录）

1. **OPS 认证端点路径修正**：spec §5.1 写 `https://ops.epo.org/3.2/rest-services/auth/accesstoken`，
   实际正确路径为 **`https://ops.epo.org/3.2/auth/accesstoken`**——auth 端点**不在** `/rest-services/`
   下，仅数据端点在其下。代码（`src/ops/auth.ts`）以正确路径实现。
2. **OPS 以 XML 为主**：spec §5.2 把 JSON 当首选。实际上 OPS 数据端点基本只返回 XML，故统一请求
   `Accept: application/xml` 并由 `src/ops/parse.ts`（`fast-xml-parser`）解析为结构化 JSON，
   保持单一解析路径。
3. OPS XML schema 各 office 字段略有差异，`parse.ts` 的字段提取为 best-effort，建议上线时对照
   真实响应微调。

## 扩展位（Phase 3，本次未实现）

`PatentProvider` 接口下预留了 `GooglePatentsProvider`（SerpApi/Apify）的实现位与配置项
（`SERPAPI_KEY`），见 `src/provider.ts` 与 `wrangler.jsonc` 注释。接入时无需改动工具层。
