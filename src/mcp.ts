import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./types";
import { OpsProvider } from "./provider";
import { OpsError } from "./ops/client";
import { googlePatentSearch, SerpApiError } from "./serpapi/client";

const formatSchema = z
  .enum(["epodoc", "docdb"])
  .default("epodoc")
  .describe("公开号格式：epodoc（默认，如 EP1234567）或 docdb。");

const publicationNumberSchema = z
  .string()
  .min(1)
  .describe("专利公开号，如 EP1234567 或 US2025236871A1（必要时带 kind code）。");

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});

const fail = (msg: string): ToolResult => ({
  content: [{ type: "text", text: msg }],
  isError: true,
});

function errText(e: unknown): string {
  if (e instanceof OpsError || e instanceof SerpApiError) return e.message;
  if (e instanceof Error) return `工具执行出错：${e.message}`;
  return `工具执行出错：${String(e)}`;
}

/**
 * 每个请求新建一个 McpServer 实例（无状态，避免请求间数据串扰）。
 * 4 个工具全部 readOnlyHint=true（纯检索）。
 */
export function buildMcpServer(env: Env): McpServer {
  const server = new McpServer({ name: "patent-mcp-server", version: "0.1.0" });
  const provider = new OpsProvider(env);

  server.registerTool(
    "search_patents",
    {
      title: "Search patents",
      description:
        "按关键词、申请人或分类号检索专利（EPO OPS），返回命中概览（公开号、标题、申请人、发明人、公开日、IPC 分类、family_id）。" +
        "用于发现某主题/公司/技术领域的相关专利、landscape 初筛、或不知道确切公开号时。\n\n" +
        "检索策略（提高召回、避免漏检，适用所有技术领域）：\n" +
        "① 别只用单一关键词——同一技术常有多种写法，用同义/近义术语做 OR 扩展。" +
        '例：生物 ta=siRNA or ta="iRNA agent" or ta="RNAi agent" or ta=dsRNA；' +
        '电池 ta="solid-state electrolyte" or ta="solid electrolyte" or ta=SSE；' +
        '半导体 ta=FinFET or ta="fin field-effect transistor"。\n' +
        "② 用分类号 ic=（IPC）/ cpc=（CPC）兜底——分类号不受用词影响，能跨术语捕获" +
        "（如 ic=C12N15/113 覆盖 siRNA 类），是治术语变体漏检最有效的免费手段。\n" +
        "③ 锁定龙头/竞品时用 pa= 申请人定向兜底（如 pa=alnylam）。\n" +
        "④ 对命中结果可取其 family_id 调 get_patent_family 顺藤摸同族、交叉验证。\n\n" +
        "注意：OPS 仅匹配【标题+摘要】、做字面匹配。若担心术语变体仍漏检（尤其 FTO 场景），" +
        "改用 search_patents_google（Google 引擎自带语义/同义扩展，召回更高）。" +
        "拿到 publication_number 后用 get_patent_details / get_patent_claims / get_patent_family 取详情。",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe(
            "EPO OPS CQL 检索式。字段：ti=（标题）、ab=（摘要）、ta=（标题+摘要）、pa=（申请人）、in=（发明人）、" +
              "ic=（IPC 分类号）、cpc=（CPC 分类号）。" +
              '多词短语必须加引号（如 ta="GalNAc siRNA"），或用 and/or 连接（如 ta=GalNAc and ta=siRNA）；' +
              "勿用空格分隔的裸多词（OPS 会 404）。" +
              "善用同义词 OR 扩展 + 分类号兜底跨越术语变体，如 'ta=PCSK9 and ic=C12N15/113'、" +
              "'(ta=siRNA or ta=\"iRNA agent\") and pa=alnylam'。",
          ),
        limit: z.number().int().min(1).max(25).default(10).describe("返回条数，默认 10，上限 25。"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }) => {
      try {
        return ok(await provider.searchPatents(query, limit ?? 10));
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  server.registerTool(
    "get_patent_details",
    {
      title: "Get patent details",
      description:
        "取单篇专利的著录项目（biblio）与摘要：标题、摘要、申请人、发明人、IPC/CPC 分类、申请日、公开日、优先权日。" +
        "已知具体公开号、需要专利书目信息或摘要时使用。",
      inputSchema: {
        publication_number: publicationNumberSchema,
        format: formatSchema,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ publication_number, format }) => {
      try {
        return ok(await provider.getDetails(publication_number, format ?? "epodoc"));
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  server.registerTool(
    "get_patent_claims",
    {
      title: "Get patent claims",
      description:
        "取单篇专利的完整权利要求文本（按权利要求编号分条）及总条数。" +
        "用于 claim 分析、FTO（自由实施）评估、enablement 评估，或用户想读某专利保护范围时使用。",
      inputSchema: {
        publication_number: publicationNumberSchema,
        format: formatSchema,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ publication_number, format }) => {
      try {
        return ok(await provider.getClaims(publication_number, format ?? "epodoc"));
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  server.registerTool(
    "get_patent_family",
    {
      title: "Get patent family",
      description:
        "取 INPADOC 专利族成员（各成员公开号 + 国家）与法律状态事件。" +
        "用于全球专利布局分析、同族检索、以及有效性 / 法律状态判断时使用。",
      inputSchema: {
        publication_number: publicationNumberSchema,
        format: formatSchema,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ publication_number, format }) => {
      try {
        return ok(await provider.getFamily(publication_number, format ?? "epodoc"));
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  server.registerTool(
    "search_patents_google",
    {
      title: "Search patents (Google Patents, high recall)",
      description:
        "用 Google Patents 引擎做【高召回 / 跨术语】检索（经 SerpApi），Google 会自动做相关性排序与同义扩展。" +
        "适用场景：FTO 初筛广撒网；或当 search_patents（基于 EPO OPS 标题摘要的字面匹配）可能漏掉术语变体时" +
        "（例如 siRNA 在专利里又写作 'iRNA agent' / 'RNAi agent' / 'dsRNA'）。" +
        "查询用 Google Patents 风格的关键词与布尔运算（如 '(PCSK9) (siRNA OR \"iRNA agent\" OR dsRNA)'），" +
        "不要用 OPS 的 CQL 语法。返回含 publication_number，可再用 get_patent_details / get_patent_claims / get_patent_family 取结构化详情、权利要求与同族。",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe(
            "Google Patents 检索式：自然关键词 + 布尔运算，多词短语用引号。示例：'(PCSK9) (siRNA OR \"iRNA agent\" OR dsRNA)'。",
          ),
        limit: z.number().int().min(10).max(100).default(10).describe("返回条数，10–100，默认 10。"),
        country: z
          .string()
          .optional()
          .describe("可选：国家码过滤，逗号分隔（如 'US,WO,EP,CN'）。"),
        status: z
          .enum(["GRANT", "APPLICATION"])
          .optional()
          .describe("可选：仅授权(GRANT) 或仅申请(APPLICATION)。"),
        sort: z
          .enum(["relevance", "new", "old"])
          .default("relevance")
          .describe("排序：relevance（默认，Google 相关性）/ new（最新）/ old（最早）。"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit, country, status, sort }) => {
      try {
        return ok(
          await googlePatentSearch(env, query, {
            num: limit ?? 10,
            country,
            status,
            sort: sort ?? "relevance",
          }),
        );
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  return server;
}
