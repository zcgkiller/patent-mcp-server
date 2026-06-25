import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Env, UserProps } from "./types";

/**
 * defaultHandler：处理对 Claude 的 OAuth 授权页与 Cloudflare Access 上游回调。
 *
 * 流程：
 *   Claude → GET /authorize  → 解析 MCP 授权请求 → 跳到 Cloudflare Access 授权端点
 *   Access → GET /callback   → 用 code 换 id_token → 取 email → completeAuthorization
 *
 * /token、/register 由 @cloudflare/workers-oauth-provider 内部处理，不在此。
 */
export const accessHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (url.pathname === "/authorize") {
        return await handleAuthorize(request, env, url);
      }
      if (url.pathname === "/callback") {
        return await handleCallback(request, env, url);
      }
      if (url.pathname === "/" || url.pathname === "") {
        return new Response(
          "Patent MCP Server is running. MCP endpoint: /mcp (OAuth 2.1 required).",
          { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } },
        );
      }
      return new Response("Not found", { status: 404 });
    } catch (e) {
      // 防止裸异常变成 Cloudflare 1101；返回可读错误。
      const msg = e instanceof Error ? e.message : String(e);
      return new Response(`Auth handler error: ${msg}`, {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  },
};

/** 校验 Access 上游配置是否齐全且为合法 URL，缺失时给出明确诊断（不泄露密钥值）。 */
function validateAccessConfig(env: Env): string | null {
  const required: [string, string | undefined][] = [
    ["ACCESS_CLIENT_ID", env.ACCESS_CLIENT_ID],
    ["ACCESS_CLIENT_SECRET", env.ACCESS_CLIENT_SECRET],
    ["ACCESS_AUTHORIZATION_URL", env.ACCESS_AUTHORIZATION_URL],
    ["ACCESS_TOKEN_URL", env.ACCESS_TOKEN_URL],
  ];
  const missing = required.filter(([, v]) => !v || v.length === 0).map(([k]) => k);
  if (missing.length) return `Missing Access secrets: ${missing.join(", ")}`;
  for (const key of ["ACCESS_AUTHORIZATION_URL", "ACCESS_TOKEN_URL"] as const) {
    try {
      new URL(env[key]);
    } catch {
      return `Invalid URL in ${key} (length=${env[key].length})`;
    }
  }
  return null;
}

async function handleAuthorize(request: Request, env: Env, url: URL): Promise<Response> {
  const configError = validateAccessConfig(env);
  if (configError) {
    return new Response(`Access 配置错误：${configError}`, {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  if (!oauthReqInfo.clientId) {
    return new Response("Invalid authorization request: missing client_id", { status: 400 });
  }

  // 把 Claude 的 MCP 授权请求信息编码进 state，带去 Access，回调时取回。
  const state = base64UrlEncode(JSON.stringify(oauthReqInfo));
  const redirectUri = `${url.origin}/callback`;

  const authUrl = new URL(env.ACCESS_AUTHORIZATION_URL);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", env.ACCESS_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("state", state);

  return Response.redirect(authUrl.toString(), 302);
}

async function handleCallback(request: Request, env: Env, url: URL): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return new Response("Missing code or state from upstream", { status: 400 });
  }

  let oauthReqInfo: AuthRequest;
  try {
    oauthReqInfo = JSON.parse(base64UrlDecode(state)) as AuthRequest;
  } catch {
    return new Response("Invalid state", { status: 400 });
  }

  const redirectUri = `${url.origin}/callback`;
  const tokenRes = await fetch(env.ACCESS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: env.ACCESS_CLIENT_ID,
      client_secret: env.ACCESS_CLIENT_SECRET,
    }).toString(),
  });

  if (!tokenRes.ok) {
    const detail = await tokenRes.text().catch(() => "");
    return new Response(`Access token exchange failed (HTTP ${tokenRes.status}). ${detail.slice(0, 200)}`, {
      status: 502,
    });
  }

  const tokenData = (await tokenRes.json()) as { id_token?: string; access_token?: string };
  const claims = decodeJwtClaims(tokenData.id_token);
  const email = (claims.email as string) ?? (claims.sub as string) ?? "unknown";
  const name = (claims.name as string) ?? null;

  const props: UserProps = { email, name };

  // 注意：此处未校验 id_token 签名。token 经 TLS 由 Access 直接换得（server-to-server），
  // 传输可信。如需更强保证，可用 env.ACCESS_JWKS_URL 验签后再放行。
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo,
    userId: email,
    metadata: { label: email },
    scope: oauthReqInfo.scope,
    props,
  });

  return Response.redirect(redirectTo, 302);
}

// ── base64url 辅助（Workers 全局有 btoa/atob）─────────────────────────────

function base64UrlEncode(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): string {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  b64 += "=".repeat((4 - (b64.length % 4)) % 4);
  return atob(b64);
}

function decodeJwtClaims(jwt?: string): Record<string, unknown> {
  if (!jwt) return {};
  const parts = jwt.split(".");
  if (parts.length < 2) return {};
  try {
    return JSON.parse(base64UrlDecode(parts[1])) as Record<string, unknown>;
  } catch {
    return {};
  }
}
