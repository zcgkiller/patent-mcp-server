import type { Env, GoogleSearchResult, GooglePatentHit } from "../types";

/**
 * Google Patents 检索（经 SerpApi google_patents engine）。
 * 借用 Google Patents 引擎的相关性排序与跨术语召回，补 OPS 标题摘要字面匹配的不足。
 */
const SERPAPI_BASE = "https://serpapi.com/search.json";

export class SerpApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SerpApiError";
  }
}

export interface GoogleSearchOptions {
  num?: number;
  country?: string;
  status?: "GRANT" | "APPLICATION";
  sort?: "relevance" | "new" | "old";
}

function toArr(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string") return v ? [v] : [];
  return [];
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length ? v : null;
}

function mapHit(r: Record<string, unknown>): GooglePatentHit {
  return {
    publication_number: str(r["publication_number"]),
    patent_id: str(r["patent_id"]),
    title: str(r["title"]),
    assignees: toArr(r["assignee"]),
    inventors: toArr(r["inventor"]),
    priority_date: str(r["priority_date"]),
    filing_date: str(r["filing_date"]),
    publication_date: str(r["publication_date"]),
    snippet: str(r["snippet"]),
    pdf: str(r["pdf"]),
  };
}

export async function googlePatentSearch(
  env: Env,
  query: string,
  opts: GoogleSearchOptions = {},
): Promise<GoogleSearchResult> {
  if (!env.SERPAPI_KEY) {
    throw new SerpApiError(
      "未配置 SERPAPI_KEY：请用 `wrangler secret put SERPAPI_KEY` 注入 SerpApi 的 API key 后再用本工具；或改用 search_patents（EPO OPS，无需额外 key）。",
    );
  }

  const url = new URL(SERPAPI_BASE);
  url.searchParams.set("engine", "google_patents");
  url.searchParams.set("q", query);
  url.searchParams.set("api_key", env.SERPAPI_KEY);
  const num = Math.min(Math.max(Math.floor(opts.num ?? 10), 10), 100); // SerpApi num 范围 10-100
  url.searchParams.set("num", String(num));
  if (opts.country) url.searchParams.set("country", opts.country);
  if (opts.status) url.searchParams.set("status", opts.status);
  if (opts.sort === "new" || opts.sort === "old") url.searchParams.set("sort", opts.sort);

  let res: Response;
  try {
    res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
  } catch (e) {
    throw new SerpApiError(`SerpApi 请求失败（网络错误）：${e instanceof Error ? e.message : String(e)}`);
  }

  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  if (data["error"]) {
    // 常见：无效 key、本月免费额度（250 次）用尽。
    throw new SerpApiError(
      `SerpApi 返回错误：${String(data["error"])}（若为额度用尽，可改用 search_patents 走 OPS；或等下月额度重置 / 升级套餐）`,
    );
  }
  if (!res.ok) {
    throw new SerpApiError(`SerpApi HTTP ${res.status}。请稍后重试或改用 search_patents（OPS）。`);
  }

  const organic = Array.isArray(data["organic_results"])
    ? (data["organic_results"] as Record<string, unknown>[])
    : [];
  const si = data["search_information"] as Record<string, unknown> | undefined;
  const total = typeof si?.["total_results"] === "number" ? (si["total_results"] as number) : null;

  return { total_results: total, results: organic.map(mapHit) };
}
