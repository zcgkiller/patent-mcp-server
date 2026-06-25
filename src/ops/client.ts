import type { Env, PatentFormat, SearchResult, PatentDetails, PatentClaims, PatentFamily } from "../types";
import { getAccessToken, refreshAccessToken, clearAccessToken } from "./auth";
import { parseSearch, parseBiblio, parseClaims, parseFamily } from "./parse";

/**
 * OPS REST 调用封装：认证、分页、throttling 处理、token 失效重试。
 * 数据端点 base（注意：与 auth 端点不同，数据端点在 /rest-services/ 下）。
 */
const OPS_BASE = "https://ops.epo.org/3.2/rest-services/";

/** 面向模型的可执行错误（actionable）。 */
export class OpsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpsError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function snippet(body: string): string {
  const t = (body || "").replace(/\s+/g, " ").trim();
  return t ? ` 详情：${t.slice(0, 200)}` : "";
}

function isRed(res: Response): boolean {
  return /red/i.test(res.headers.get("X-Throttling-Control") ?? "");
}

type OpsContext = "search" | "publication";

function mapOpsError(
  status: number,
  headers: Headers,
  body: string,
  ctx: OpsContext = "publication",
): OpsError {
  const throttle = headers.get("X-Throttling-Control");
  if (status === 404) {
    if (ctx === "search") {
      // OPS 对多词不加引号的查询会返回 404（而非空结果）；给出 CQL 语法指引。
      return new OpsError(
        '检索无结果或查询语法有误（HTTP 404）。OPS CQL 对多词短语需加引号，如 ta="GalNAc siRNA"；' +
          "或用字段限定 + 布尔运算：ti=（标题）、ab=（摘要）、ta=（标题+摘要）、pa=（申请人）、in=（发明人）、ic=（IPC），" +
          "用 and/or 连接，例如 'ta=GalNAc and ta=siRNA'。",
      );
    }
    return new OpsError(
      "未找到该专利（HTTP 404）。请检查 publication_number 格式（如 EP1234567，必要时带 kind code 如 EP1234567B1），" +
        "或先用 search_patents 找到正确公开号。注意并非所有公开号都在 OPS 收录范围内。",
    );
  }
  if (status === 403) {
    return new OpsError(
      `OPS 拒绝访问或配额受限（HTTP 403${throttle ? `，X-Throttling-Control=${throttle}` : ""}）。` +
        "可能是配额耗尽或服务繁忙，请稍后重试，或缩小检索范围 / 降低调用频率。",
    );
  }
  if (status === 400) {
    return new OpsError(
      `检索语法或参数错误（HTTP 400）。请检查 query（OPS CQL，如 'ti=siRNA and pa=alnylam'）或 publication_number 格式。${snippet(body)}`,
    );
  }
  return new OpsError(
    `OPS 请求失败（HTTP ${status}${throttle ? `，X-Throttling-Control=${throttle}` : ""}）。${snippet(body)}`,
  );
}

/** OPS 优先以 XML 返回；统一强制 XML 以走单一解析路径。 */
function doFetch(env: Env, token: string, path: string): Promise<Response> {
  return fetch(OPS_BASE + path, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/xml",
    },
  });
}

interface OpsResponse {
  body: string;
  headers: Headers;
}

/**
 * 执行一次 OPS 请求：
 *  - 401（token 失效）→ 清缓存、重取 token 后重试一次。
 *  - red throttling + 错误状态 → 短暂退避后重试一次（不无限重试）。
 */
async function opsFetch(env: Env, path: string, ctx: OpsContext = "publication"): Promise<OpsResponse> {
  let token = await getAccessToken(env);
  let res = await doFetch(env, token, path);

  if (res.status === 401) {
    await clearAccessToken(env);
    token = await refreshAccessToken(env);
    res = await doFetch(env, token, path);
  }

  if (!res.ok && isRed(res)) {
    await sleep(2000);
    res = await doFetch(env, token, path);
  }

  const body = await res.text();
  if (!res.ok) {
    throw mapOpsError(res.status, res.headers, body, ctx);
  }
  return { body, headers: res.headers };
}

const enc = (s: string) => encodeURIComponent(s.trim());

// ── 4 个数据操作 ───────────────────────────────────────────────────────

export async function opsSearch(env: Env, query: string, limit: number): Promise<SearchResult> {
  const capped = Math.min(Math.max(1, Math.floor(limit)), 25);
  const range = `1-${capped}`;
  // search/biblio 常量：一次拿回命中的著录数据，省去逐条再查。Range 走查询参数。
  const path = `published-data/search/biblio?q=${enc(query)}&Range=${range}`;
  const { body } = await opsFetch(env, path, "search");
  return parseSearch(body, range);
}

export async function opsBiblio(
  env: Env,
  publicationNumber: string,
  format: PatentFormat,
): Promise<PatentDetails> {
  const path = `published-data/publication/${format}/${enc(publicationNumber)}/biblio`;
  const { body } = await opsFetch(env, path);
  return parseBiblio(body, publicationNumber);
}

export async function opsClaims(
  env: Env,
  publicationNumber: string,
  format: PatentFormat,
): Promise<PatentClaims> {
  const path = `published-data/publication/${format}/${enc(publicationNumber)}/claims`;
  const { body } = await opsFetch(env, path);
  return parseClaims(body, publicationNumber);
}

export async function opsFamily(
  env: Env,
  publicationNumber: string,
  format: PatentFormat,
): Promise<PatentFamily> {
  // 优先取带法律状态的 INPADOC family（legal 常量同时含成员 + 法律事件）。
  // 若账户无 legal 权限或该端点不可用，退回仅成员的 family。
  const num = enc(publicationNumber);
  try {
    const { body } = await opsFetch(env, `family/publication/${format}/${num}/legal`);
    return parseFamily(body, publicationNumber);
  } catch (e) {
    if (e instanceof OpsError) {
      const { body } = await opsFetch(env, `family/publication/${format}/${num}`);
      return parseFamily(body, publicationNumber);
    }
    throw e;
  }
}
