import type { Env } from "../types";

/**
 * EPO OPS client-credentials 认证 + token 缓存。
 *
 * 注意（与 spec §5.1 的差异）：OPS auth 端点是 `https://ops.epo.org/3.2/auth/accesstoken`，
 * **不在** `/rest-services/` 下（spec 写错了）。只有数据端点在 `/rest-services/` 下。
 * 见 README「与 spec 的差异」。
 */
const OPS_AUTH_URL = "https://ops.epo.org/3.2/auth/accesstoken";
const TOKEN_KV_KEY = "ops_token";

/** 取 access token：优先读 KV 缓存，未命中/过期才向 OPS 重新换取。 */
export async function getAccessToken(env: Env): Promise<string> {
  const cached = await env.OAUTH_KV.get(TOKEN_KV_KEY);
  if (cached) return cached;
  return refreshAccessToken(env);
}

/** 强制向 OPS 重新换取 token 并写回缓存（token 失效时调用）。 */
export async function refreshAccessToken(env: Env): Promise<string> {
  if (!env.OPS_CONSUMER_KEY || !env.OPS_CONSUMER_SECRET) {
    throw new Error(
      "OPS 凭据未配置：请用 `wrangler secret put OPS_CONSUMER_KEY` 和 OPS_CONSUMER_SECRET 注入。",
    );
  }

  const basic = btoa(`${env.OPS_CONSUMER_KEY}:${env.OPS_CONSUMER_SECRET}`);
  const res = await fetch(OPS_AUTH_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `OPS 认证失败 (HTTP ${res.status})：请检查 OPS_CONSUMER_KEY/SECRET 是否正确、应用是否已激活。` +
        (body ? ` 详情：${body.slice(0, 200)}` : ""),
    );
  }

  const data = (await res.json()) as { access_token?: string; expires_in?: string | number };
  if (!data.access_token) {
    throw new Error("OPS 认证响应缺少 access_token。");
  }

  const expiresIn = Number(data.expires_in ?? 1200);
  // TTL = expires_in - 60s，留一分钟安全边界；KV 最小 TTL 60s。
  const ttl = Math.max(60, Math.floor(expiresIn) - 60);
  await env.OAUTH_KV.put(TOKEN_KV_KEY, data.access_token, { expirationTtl: ttl });
  return data.access_token;
}

/** 清除缓存的 token（收到 401 时调用）。 */
export async function clearAccessToken(env: Env): Promise<void> {
  await env.OAUTH_KV.delete(TOKEN_KV_KEY);
}
