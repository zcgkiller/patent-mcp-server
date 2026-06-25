import { XMLParser } from "fast-xml-parser";
import type {
  SearchResult,
  PatentSummary,
  PatentDetails,
  PatentClaims,
  ClaimEntry,
  PatentFamily,
  FamilyMember,
  LegalStatusEvent,
} from "../types";

/**
 * OPS XML → 结构化 JSON。
 *
 * OPS 几乎所有端点都以 XML 返回（biblio/claims/family 等），因此 XML 解析是主路径。
 * removeNSPrefix 去掉 `ops:` / `exchange:` / `ftxt:` 等命名空间前缀，便于遍历。
 *
 * 注意：OPS XML schema 较复杂且各 office 字段略有差异。下面的字段提取是按已知结构的
 * best-effort 实现；上线验证阶段应对照真实响应微调（见 spec §5.2「以真实响应字段为准」）。
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  trimValues: true,
  parseAttributeValue: false,
});

// ── 通用辅助 ───────────────────────────────────────────────────────────

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** 从 XML 节点取文本：字符串/数字直接返回，对象取 #text。 */
function text(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  if (typeof v === "object") {
    const t = (v as Record<string, unknown>)["#text"];
    if (t !== undefined) return String(t).trim() || null;
  }
  return null;
}

function uniq(arr: string[]): string[] {
  return [...new Set(arr.filter((s) => s && s.length > 0))];
}

function uniqBy<T>(arr: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of arr) {
    const k = key(item);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(item);
    }
  }
  return out;
}

interface DocId {
  country: string | null;
  docNumber: string | null;
  kind: string | null;
  date: string | null;
}

/** 从 publication-reference / application-reference 等节点取 document-id。 */
function pickDocId(refNode: unknown, preferType = "epodoc"): DocId {
  const ids = asArray((refNode as Record<string, unknown>)?.["document-id"]);
  const chosen =
    ids.find((i) => (i as Record<string, unknown>)?.["@_document-id-type"] === preferType) ?? ids[0];
  const c = chosen as Record<string, unknown> | undefined;
  return {
    country: text(c?.["country"]),
    docNumber: text(c?.["doc-number"]),
    kind: text(c?.["kind"]),
    date: text(c?.["date"]),
  };
}

function composePub(id: DocId): string {
  return `${id.country ?? ""}${id.docNumber ?? ""}${id.kind ?? ""}`;
}

/** OPS 常把每个当事人/分类列两份（data-format=epodoc 与 original）；优先 epodoc。 */
function preferEpodoc<T extends Record<string, unknown>>(list: T[]): T[] {
  const epodoc = list.filter((x) => x?.["@_data-format"] === "epodoc");
  return epodoc.length ? epodoc : list;
}

// ── 字段提取 ───────────────────────────────────────────────────────────

function pickTitle(bib: Record<string, unknown>): string | null {
  const titles = asArray(bib?.["invention-title"]);
  if (titles.length === 0) return null;
  const en = titles.find((t) => (t as Record<string, unknown>)?.["@_lang"] === "en");
  return text(en ?? titles[0]);
}

function pickParties(bib: Record<string, unknown>): { applicants: string[]; inventors: string[] } {
  const parties = (bib?.["parties"] ?? {}) as Record<string, unknown>;
  const applicantList = preferEpodoc(
    asArray((parties?.["applicants"] as Record<string, unknown>)?.["applicant"]) as Record<
      string,
      unknown
    >[],
  );
  const inventorList = preferEpodoc(
    asArray((parties?.["inventors"] as Record<string, unknown>)?.["inventor"]) as Record<
      string,
      unknown
    >[],
  );
  const applicants = applicantList
    .map((a) => text((a?.["applicant-name"] as Record<string, unknown>)?.["name"]))
    .filter((x): x is string => !!x);
  const inventors = inventorList
    .map((a) => text((a?.["inventor-name"] as Record<string, unknown>)?.["name"]))
    .filter((x): x is string => !!x);
  return { applicants: uniq(applicants), inventors: uniq(inventors) };
}

/** OPS 的 IPCR text 形如 "A61K 31/ 713 A I"；归一为紧凑分类号 "A61K31/713"。 */
function normalizeIpc(raw: string): string {
  const compact = raw.replace(/\s+/g, "");
  const m = compact.match(/^([A-H]\d{2}[A-Z]\d{1,4}\/\d{1,6})/);
  return m ? m[1] : compact;
}

function pickIpc(bib: Record<string, unknown>): string[] {
  const out: string[] = [];
  // 新格式：classifications-ipcr > classification-ipcr > text
  const ipcr = asArray(
    (bib?.["classifications-ipcr"] as Record<string, unknown>)?.["classification-ipcr"],
  );
  for (const c of ipcr) {
    const t = text((c as Record<string, unknown>)?.["text"]);
    if (t) out.push(normalizeIpc(t));
  }
  // 旧格式：classification-ipc > text
  const ipc = asArray((bib?.["classification-ipc"] as Record<string, unknown>)?.["text"]);
  for (const c of ipc) {
    const t = text(c);
    if (t) out.push(normalizeIpc(t));
  }
  return uniq(out);
}

function pickCpc(bib: Record<string, unknown>): string[] {
  const out: string[] = [];
  const list = asArray(
    (bib?.["patent-classifications"] as Record<string, unknown>)?.["patent-classification"],
  );
  for (const raw of list) {
    const pc = raw as Record<string, unknown>;
    const scheme =
      ((pc?.["classification-scheme"] as Record<string, unknown>)?.["@_scheme"] as string) ?? "";
    if (scheme && scheme.toUpperCase() !== "CPC") continue;
    const section = text(pc?.["section"]) ?? "";
    const cls = text(pc?.["class"]) ?? "";
    const subclass = text(pc?.["subclass"]) ?? "";
    const mainGroup = text(pc?.["main-group"]) ?? "";
    const subGroup = text(pc?.["subgroup"]) ?? "";
    if (section && cls) {
      out.push(`${section}${cls}${subclass}${mainGroup}${subGroup ? "/" + subGroup : ""}`);
    }
  }
  return uniq(out);
}

function pickAbstract(ed: Record<string, unknown>): string | null {
  const abs = asArray(ed?.["abstract"]);
  const en = abs.find((a) => (a as Record<string, unknown>)?.["@_lang"] === "en") ?? abs[0];
  if (!en) return null;
  const paras = asArray((en as Record<string, unknown>)?.["p"])
    .map((p) => text(p))
    .filter((x): x is string => !!x);
  return paras.length ? paras.join("\n") : text(en);
}

// ── world-patent-data 导航 ─────────────────────────────────────────────

function firstExchangeDocument(wpd: Record<string, unknown>): Record<string, unknown> | undefined {
  const eds = asArray(wpd?.["exchange-documents"]).flatMap((x) =>
    asArray((x as Record<string, unknown>)?.["exchange-document"]),
  );
  return eds[0] as Record<string, unknown> | undefined;
}

function exchangeDocToSummary(ed: Record<string, unknown>): PatentSummary {
  const bib = (ed?.["bibliographic-data"] ?? {}) as Record<string, unknown>;
  const pubRef = (bib?.["publication-reference"] ?? {}) as Record<string, unknown>;
  const id = pickDocId(pubRef, "epodoc");
  const composed = composePub(id);
  const fallback = `${text(ed?.["@_country"]) ?? ""}${text(ed?.["@_doc-number"]) ?? ""}${
    text(ed?.["@_kind"]) ?? ""
  }`;
  const { applicants, inventors } = pickParties(bib);
  return {
    publication_number: composed || fallback,
    title: pickTitle(bib),
    applicants,
    inventors,
    publication_date: id.date,
    ipc_classes: pickIpc(bib),
    family_id: text(ed?.["@_family-id"]),
  };
}

// ── 导出的解析入口 ─────────────────────────────────────────────────────

export function parseSearch(xml: string, range: string): SearchResult {
  const root = parser.parse(xml) as Record<string, unknown>;
  const wpd = (root?.["world-patent-data"] ?? {}) as Record<string, unknown>;
  const bs = (wpd?.["biblio-search"] ?? {}) as Record<string, unknown>;
  const total = Number(bs?.["@_total-result-count"] ?? 0);
  const sr = (bs?.["search-result"] ?? {}) as Record<string, unknown>;
  const docs = asArray(sr?.["exchange-documents"]).flatMap((x) =>
    asArray((x as Record<string, unknown>)?.["exchange-document"]),
  );
  const results = docs.map((d) => exchangeDocToSummary(d as Record<string, unknown>));
  return { total: Number.isFinite(total) ? total : results.length, range, results };
}

export function parseBiblio(xml: string, fallbackNumber: string): PatentDetails {
  const root = parser.parse(xml) as Record<string, unknown>;
  const wpd = (root?.["world-patent-data"] ?? {}) as Record<string, unknown>;
  const ed = firstExchangeDocument(wpd) ?? {};
  const bib = (ed?.["bibliographic-data"] ?? {}) as Record<string, unknown>;

  const pubId = pickDocId((bib?.["publication-reference"] ?? {}) as Record<string, unknown>, "epodoc");
  const appId = pickDocId((bib?.["application-reference"] ?? {}) as Record<string, unknown>, "epodoc");
  const priorities = asArray(
    (bib?.["priority-claims"] as Record<string, unknown>)?.["priority-claim"],
  )
    .map((p) => pickDocId(p as Record<string, unknown>, "epodoc").date)
    .filter((x): x is string => !!x);

  const { applicants, inventors } = pickParties(bib);
  return {
    publication_number: composePub(pubId) || fallbackNumber,
    title: pickTitle(bib),
    abstract: pickAbstract(ed),
    applicants,
    inventors,
    ipc_classes: pickIpc(bib),
    cpc_classes: pickCpc(bib),
    filing_date: appId.date,
    publication_date: pubId.date,
    priority_dates: uniq(priorities),
  };
}

function firstFulltextDocument(wpd: Record<string, unknown>): Record<string, unknown> | undefined {
  const docs = asArray(wpd?.["fulltext-documents"]).flatMap((x) =>
    asArray((x as Record<string, unknown>)?.["fulltext-document"]),
  );
  return docs[0] as Record<string, unknown> | undefined;
}

export function parseClaims(xml: string, publicationNumber: string): PatentClaims {
  const root = parser.parse(xml) as Record<string, unknown>;
  const wpd = (root?.["world-patent-data"] ?? {}) as Record<string, unknown>;
  const fd = firstFulltextDocument(wpd) ?? {};
  const blocks = asArray(fd?.["claims"]);
  const en =
    blocks.find((b) => (b as Record<string, unknown>)?.["@_lang"] === "en") ?? blocks[0] ?? {};
  const claimEls = asArray((en as Record<string, unknown>)?.["claim"]);

  const claims: ClaimEntry[] = claimEls
    .map((raw) => {
      const c = raw as Record<string, unknown>;
      const body = (
        asArray(c?.["claim-text"])
          .map((t) => text(t))
          .filter((x): x is string => !!x)
          .join("\n") ||
        text(c) ||
        ""
      ).trim();
      let num = text(c?.["@_num"]) ?? "";
      if (num && /^\d+$/.test(num)) {
        num = String(parseInt(num, 10)); // OPS 常给 "0001" → "1"
      } else if (!num) {
        const m = body.match(/^\s*(\d+)\s*\./); // 退而从正文首部 "1." 提取
        num = m ? m[1] : "";
      }
      return { number: num, text: body };
    })
    .filter((c) => c.text.length > 0);

  return { publication_number: publicationNumber, claims_count: claims.length, claims };
}

export function parseFamily(xml: string, _publicationNumber: string): PatentFamily {
  const root = parser.parse(xml) as Record<string, unknown>;
  const wpd = (root?.["world-patent-data"] ?? {}) as Record<string, unknown>;
  const fam = (wpd?.["patent-family"] ?? {}) as Record<string, unknown>;
  const members = asArray(fam?.["family-member"]);

  const family_members: FamilyMember[] = [];
  const legal_status_events: LegalStatusEvent[] = [];
  let familyId = text(fam?.["@_family-id"]);

  for (const raw of members) {
    const m = raw as Record<string, unknown>;
    if (!familyId) familyId = text(m?.["@_family-id"]);
    const id = pickDocId((m?.["publication-reference"] ?? {}) as Record<string, unknown>, "docdb");
    const pub = composePub(id);
    if (pub) family_members.push({ publication_number: pub, country: id.country ?? "" });

    for (const lgRaw of asArray(m?.["legal"])) {
      const lg = lgRaw as Record<string, unknown>;
      legal_status_events.push({
        code: text(lg?.["@_code"]) ?? text(lg?.["@_event-code"]),
        description: text(lg?.["@_desc"]) ?? text(lg?.["@_event-desc"]),
        date: text(lg?.["@_date"]) ?? text(lg?.["@_change-date"]),
        country: id.country,
      });
    }
  }

  return {
    family_id: familyId,
    family_members: uniqBy(family_members, (x) => x.publication_number),
    legal_status_events,
  };
}
