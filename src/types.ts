import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

/** Worker 运行时绑定与密钥。 */
export interface Env {
  /** KV：OAuth 授权态 + OPS token 缓存。 */
  OAUTH_KV: KVNamespace;

  /** 由 @cloudflare/workers-oauth-provider 在运行时注入的辅助 API。 */
  OAUTH_PROVIDER: OAuthHelpers;

  // ── EPO OPS 凭据（secret）──
  OPS_CONSUMER_KEY: string;
  OPS_CONSUMER_SECRET: string;

  // ── OAuth provider（secret）──
  COOKIE_ENCRYPTION_KEY: string;

  // ── Cloudflare Access for SaaS (OIDC) 上游身份（secret / 配置）──
  ACCESS_CLIENT_ID: string;
  ACCESS_CLIENT_SECRET: string;
  ACCESS_AUTHORIZATION_URL: string;
  ACCESS_TOKEN_URL: string;
  ACCESS_JWKS_URL?: string;

  // ── Google Patents（SerpApi，高召回/跨术语检索）──
  SERPAPI_KEY?: string;
}

/** OPS 公开号格式。 */
export type PatentFormat = "epodoc" | "docdb";

/** 通过 OAuth 流程注入到 MCP 上下文的用户属性。 */
export interface UserProps {
  email: string;
  name: string | null;
  [key: string]: unknown;
}

// ── 工具输出（清洗后的结构化 JSON）─────────────────────────────────────

export interface PatentSummary {
  publication_number: string;
  title: string | null;
  applicants: string[];
  inventors: string[];
  publication_date: string | null;
  ipc_classes: string[];
  family_id: string | null;
}

export interface SearchResult {
  total: number;
  range: string;
  results: PatentSummary[];
}

export interface PatentDetails {
  publication_number: string;
  title: string | null;
  abstract: string | null;
  applicants: string[];
  inventors: string[];
  ipc_classes: string[];
  cpc_classes: string[];
  filing_date: string | null;
  publication_date: string | null;
  priority_dates: string[];
}

export interface ClaimEntry {
  number: string;
  text: string;
}

export interface PatentClaims {
  publication_number: string;
  claims_count: number;
  claims: ClaimEntry[];
}

export interface FamilyMember {
  publication_number: string;
  country: string;
}

export interface LegalStatusEvent {
  code: string | null;
  description: string | null;
  date: string | null;
  country: string | null;
}

export interface PatentFamily {
  family_id: string | null;
  family_members: FamilyMember[];
  legal_status_events: LegalStatusEvent[];
}

// ── Google Patents（SerpApi）检索输出 ──────────────────────────────────

export interface GooglePatentHit {
  publication_number: string | null;
  patent_id: string | null;
  title: string | null;
  assignees: string[];
  inventors: string[];
  priority_date: string | null;
  filing_date: string | null;
  publication_date: string | null;
  snippet: string | null;
  pdf: string | null;
}

export interface GoogleSearchResult {
  total_results: number | null;
  results: GooglePatentHit[];
}
