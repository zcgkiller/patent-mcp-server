import type {
  Env,
  PatentFormat,
  SearchResult,
  PatentDetails,
  PatentClaims,
  PatentFamily,
} from "./types";
import { opsSearch, opsBiblio, opsClaims, opsFamily } from "./ops/client";

/**
 * 数据源抽象。工具层只依赖此接口，后续接入新数据源（如 Google Patents）时
 * 新增一个实现即可，无需改动 mcp.ts。
 */
export interface PatentProvider {
  searchPatents(query: string, limit: number): Promise<SearchResult>;
  getDetails(publicationNumber: string, format: PatentFormat): Promise<PatentDetails>;
  getClaims(publicationNumber: string, format: PatentFormat): Promise<PatentClaims>;
  getFamily(publicationNumber: string, format: PatentFormat): Promise<PatentFamily>;
}

/** 第一个实现：EPO OPS。 */
export class OpsProvider implements PatentProvider {
  constructor(private readonly env: Env) {}

  searchPatents(query: string, limit: number): Promise<SearchResult> {
    return opsSearch(this.env, query, limit);
  }
  getDetails(publicationNumber: string, format: PatentFormat): Promise<PatentDetails> {
    return opsBiblio(this.env, publicationNumber, format);
  }
  getClaims(publicationNumber: string, format: PatentFormat): Promise<PatentClaims> {
    return opsClaims(this.env, publicationNumber, format);
  }
  getFamily(publicationNumber: string, format: PatentFormat): Promise<PatentFamily> {
    return opsFamily(this.env, publicationNumber, format);
  }
}

// ── Google Patents（SerpApi）──────────────────────────────────────────────
// 已实现为独立的高召回检索能力：见 src/serpapi/client.ts 的 googlePatentSearch()，
// 对应工具 search_patents_google（mcp.ts）。配置项：env.SERPAPI_KEY。
// 它只补"检索"这一环（Google 引擎的相关性排序 + 跨术语召回）；详情/权利要求/同族仍走 OPS。
// 未来若要把它纳入 PatentProvider 接口统一路由，可在此包一层 GooglePatentsProvider。
