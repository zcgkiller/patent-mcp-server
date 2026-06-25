# 实施 Brief：专利数据库 Remote MCP Server

> 交付对象：Claude Code
> 目标读者：执行此 brief 的编码 agent。决策已锁定，按"实施阶段"顺序推进。遇到与现行官方文档冲突时，**以官方文档为准并记录差异**，不要自行猜测 API 路径。

---

## 1. 目标

构建一个 **remote MCP server**，让 Claude（claude.ai / Desktop / Cowork / mobile 全端）能在对话中实时检索专利数据。第一数据源为 **EPO OPS（European Patent Office Open Patent Services）**，架构需预留扩展位以便后续接入 Google Patents（SerpApi/Apify）。

部署在 **Cloudflare Workers**，与用户的其他基础设施完全隔离（不依赖任何自有 VPS）。

---

## 2. 技术栈（已锁定）

| 项目 | 选型 | 理由 |
|---|---|---|
| 运行时 | Cloudflare Workers | 边缘部署、自带 TLS、IP 与自有服务器解耦、近零成本 |
| 语言 | TypeScript | Workers MCP 工具链 TS-first |
| MCP 处理 | `createMcpHandler()`（无状态） | 专利检索是无状态请求-响应，不需要 Durable Objects |
| 传输 | Streamable HTTP | SSE 已废弃，新部署一律 Streamable HTTP |
| 认证 | `@cloudflare/workers-oauth-provider`（OAuth 2.1） | Claude 连接 custom connector 要求 OAuth |
| 部署 | Wrangler CLI | — |
| 密钥 | `wrangler secret put` | 不进代码、不进 git |
| KV | 一个 KV namespace（绑定名 `OAUTH_KV`） | workers-oauth-provider 存授权态；同时用于缓存 OPS token |

**不要做的事：** 不要用 SSE-only 实现；不要把任何 API key 写进代码或 wrangler.jsonc 明文；不要把 OPS server 做成"全 API schema 的薄包装"——只暴露下面定义的几个目标导向工具。

---

## 3. 架构与数据流

```
Claude (MCP client)
   │  OAuth 2.1 (Streamable HTTP)
   ▼
Cloudflare Worker  ──── workers-oauth-provider 处理 Claude 侧 OAuth
   │                └── 用户身份网关（见 §6）
   │  内部：每个 MCP tool → EPO OPS REST 调用
   ▼
EPO OPS API (ops.epo.org)
   └── 出站 fetch()，Worker 持有 OPS consumer key/secret
```

Worker 对 Claude 是 OAuth provider；对 EPO OPS 是普通 API client（client-credentials）。两套认证互不混淆。

---

## 4. MCP 工具清单（暴露给 Claude 的 4 个工具）

遵循"少而精"原则。**全部工具标注 `readOnlyHint: true`**（纯检索，无写操作）。每个工具的 description 必须同时写清"做什么 + 何时用"，这是触发准确率的关键。输出统一为清洗后的结构化 JSON（不要把 OPS 原始 XML 直接塞回去）。

### 4.1 `search_patents`
- 入参：`query`（string，关键词或 CQL 表达式）、`limit`（int，默认 10，上限 25）
- 出参：命中列表，每条含 `publication_number`、`title`、`applicants[]`、`inventors[]`、`publication_date`、`ipc_classes[]`、`family_id`
- 用途说明：按关键词/申请人/分类号检索专利，返回命中概览供进一步取详情

### 4.2 `get_patent_details`
- 入参：`publication_number`（string，如 `EP1234567` 或 `US2025236871A1`）、`format`（可选，`epodoc`|`docdb`，默认 `epodoc`）
- 出参：`title`、`abstract`、`applicants[]`、`inventors[]`、`ipc_classes[]`、`cpc_classes[]`、`filing_date`、`publication_date`、`priority_dates[]`
- 用途说明：取单篇专利的著录项目（biblio）与摘要

### 4.3 `get_patent_claims`
- 入参：`publication_number`、`format`（同上）
- 出参：`claims`（结构化，按权利要求编号分条），`claims_count`
- 用途说明：取单篇专利的完整权利要求文本，用于 claim 分析、FTO、enablement 评估

### 4.4 `get_patent_family`
- 入参：`publication_number`、`format`（同上）
- 出参：`family_members[]`（各成员 `publication_number` + `country`）、`legal_status_events[]`（事件类型、日期、当前状态）
- 用途说明：取 INPADOC 专利族成员与法律状态，用于布局分析与有效性判断

> 错误处理要求：所有工具在失败时返回 **actionable** 的错误信息（如"OPS 配额耗尽，X-Throttling-Control=red，请稍后重试"或"未找到 publication_number，请检查格式或改用 search_patents"），让模型能据此重试或换参，而不是抛裸异常。

---

## 5. EPO OPS 接入细节

> 实施前请核对当前 OPS 文档（https://www.epo.org/en/searching-for-patents/data/web-services/ops 及 OPS REST 文档），下列为已知结构，路径以官方为准。

### 5.1 认证（client-credentials）
1. 用户在 EPO OPS 注册应用，获得 **Consumer Key** + **Consumer Secret**（见 §11 由用户提供）。
2. Worker 调用 token 端点换 access token：
   - `POST https://ops.epo.org/3.2/rest-services/auth/accesstoken`
   - Header：`Authorization: Basic base64(consumer_key:consumer_secret)`
   - Body：`grant_type=client_credentials`
   - 返回含 `access_token` 与 `expires_in`（约 1200 秒）。
3. **Token 缓存**：把 access token 连同过期时间写入 `OAUTH_KV`（key 如 `ops_token`，TTL 设为 `expires_in - 60s`）。每次工具调用先查缓存，过期才重新换取——避免反复打 auth 端点。

### 5.2 数据端点（base：`https://ops.epo.org/3.2/rest-services/`）
- 检索：`published-data/search?q=<CQL>`，分页用 `Range` header（如 `1-25`）
- 著录：`published-data/publication/{format}/{number}/biblio`
- 权利要求：`published-data/publication/{format}/{number}/claims`
- 专利族：`family/publication/{format}/{number}`（INPADOC family，可带 biblio/legal）
- 法律状态：family/legal 相关端点
- 所有请求带 `Authorization: Bearer <access_token>`
- **优先请求 JSON**：`Accept: application/json`；若某端点仅返回 XML，则在 Worker 内解析 XML 转结构化 JSON（不要把 XML 透传给 Claude）。

### 5.3 限流与配额（必须处理）
- 读取响应的 `X-Throttling-Control` header，识别当前负载色（green/yellow/red）与各服务限额。
- 遇 403/配额相关错误时，返回明确的 actionable 错误（见 §4 错误处理），不要静默失败或无限重试。
- 内置简单退避：red 状态下短暂退避后单次重试，仍失败则上报。

---

## 6. 认证 / 用户网关（需用户确认，见 §11）

Worker 用 `@cloudflare/workers-oauth-provider` 对 Claude 暴露标准 OAuth 2.1。**上游用户身份**有三种可选，推荐按团队场景选 Cloudflare Access：

- **推荐：Cloudflare Access** —— 把团队成员邮箱（公司域）配进 Access policy，只有通过的人能连。最适合 ~5 人内部团队的访问门禁。
- 备选：GitHub / Google OAuth（适合个人或已有 GitHub org）
- 仅开发期：authless（见实施阶段 Phase 1）

provider 配置需提供 authorize / token / client registration 端点路径；KV namespace（`OAUTH_KV`）用于存储授权态与加密 token。`COOKIE_ENCRYPTION_KEY` 用 `openssl rand -hex 32` 生成后存为 secret。

---

## 7. Secrets 与配置

通过 `wrangler secret put` 注入（不进 git）：
- `OPS_CONSUMER_KEY`
- `OPS_CONSUMER_SECRET`
- `COOKIE_ENCRYPTION_KEY`
- （若选 Access/GitHub/Google）对应的 `*_CLIENT_ID` / `*_CLIENT_SECRET`

`wrangler.jsonc` 中声明：KV namespace 绑定（`OAUTH_KV`）、Worker 名称、兼容性日期。预留注释位用于将来加入 Google Patents 的 `SERPAPI_KEY`。

---

## 8. 项目结构

```
patent-mcp-server/
├── src/
│   ├── index.ts            # Worker 入口：OAuth provider + createMcpHandler 装配
│   ├── mcp.ts              # 4 个工具的定义与 handler
│   ├── ops/
│   │   ├── auth.ts         # OPS client-credentials + token 缓存
│   │   ├── client.ts       # OPS REST 调用封装、throttling 处理
│   │   └── parse.ts        # OPS 响应 → 结构化 JSON（含 XML→JSON）
│   └── types.ts            # 工具 I/O 与 OPS 响应类型
├── wrangler.jsonc
├── package.json
├── tsconfig.json
└── README.md               # 部署步骤、所需 secrets、如何连到 Claude
```

数据源做成可扩展接口（如 `PatentProvider`），EPO OPS 是第一个实现，便于后续加 Google Patents provider 而不改工具层。

---

## 9. 实施阶段（按序）

**Phase 1 — authless 验证（先跑通数据链路）**
- 用 `createMcpHandler()` 起一个无认证 Worker，实现 4 个工具 + OPS 接入。
- `wrangler deploy` 后用 MCP Inspector 逐个工具验证：search → details → claims → family 跑通，返回结构化 JSON。
- 验收：用一个已知公开号（如 `US2025236871A1`）能正确取回 claims。

**Phase 2 — 加 OAuth + 用户网关**
- 接入 `@cloudflare/workers-oauth-provider` 与选定的上游身份（见 §6）。
- 用 MCP Inspector 的 OAuth flow 验证授权链路。
- 在 claude.ai 设置 → Connectors → Add custom connector，填入 `https://<worker>.workers.dev/mcp`，走完 OAuth，确认能 List Tools 并调用。

**Phase 3 — 扩展位（本次不实现，留接口）**
- 在 `PatentProvider` 接口下预留 Google Patents（SerpApi/Apify）实现的位置与配置项注释。

---

## 10. 验收标准

- [ ] MCP Inspector 能列出 4 个工具，且每个都能成功调用返回结构化 JSON
- [ ] OPS token 正确缓存，连续多次调用不重复打 auth 端点
- [ ] 命中 throttling/配额时返回 actionable 错误而非崩溃
- [ ] claude.ai 上作为 custom connector 成功连接并通过 OAuth
- [ ] 在 Claude 对话中自然语言提问（如"查 RBP4 GalNAc siRNA 相关专利的权利要求"）能触发工具并返回有效结果
- [ ] README 写清部署步骤与所需 secrets，他人可照抄复现

---

## 11. 需用户（项目方）先提供/确认的输入

> Claude Code 无法自行获取以下内容，开工前请向项目方索取：

1. **EPO OPS 凭据**：Consumer Key + Consumer Secret（需先在 EPO OPS 注册应用）
2. **OAuth 上游身份选择**：Cloudflare Access（推荐）/ GitHub / Google —— 决定 Phase 2 配置
3. **Worker 域名**：用默认 `*.workers.dev` 还是绑自有子域名
4. **Cloudflare 账户**：已登录的 Wrangler 环境 / 账户 ID

---

## 12. 重要约束（务必遵守）

- **保密性提示**：所有检索 query 与返回数据会经过 Cloudflare 边缘。本服务用于 landscape / 公开专利分析；涉及未公开 FTO 思路或精准竞品狙击的高敏感检索，应在调用前将 query 泛化，或改用自托管链路（不在本方案范围）。在 README 中明确写出此提示。
- **回源防护**：若绑自有域名并用 CF 代理，配置防火墙仅接受 Cloudflare IP 段流量。
- **最小权限**：所有工具只读；不实现任何写/删除专利数据的能力。
- **配额友好**：尊重 OPS 的 `X-Throttling-Control`，避免触发封禁。
