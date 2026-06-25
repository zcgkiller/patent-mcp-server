import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp";
import { buildMcpServer } from "./mcp";
import { accessHandler } from "./access";
import type { Env } from "./types";

/**
 * MCP API handler（Streamable HTTP，无状态）。
 * 每请求新建 McpServer 实例，避免请求间数据串扰。
 */
const mcpApiHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const server = buildMcpServer(env);
    return createMcpHandler(server)(request, env, ctx);
  },
};

/**
 * Worker 入口：用 OAuthProvider 对 Claude 暴露 OAuth 2.1。
 *  - /mcp           → 受保护的 MCP 端点（apiHandler）
 *  - /authorize     → 授权页 / 跳转 Cloudflare Access（defaultHandler）
 *  - /callback      → Access 回调（defaultHandler）
 *  - /token /register → 由 OAuthProvider 内部处理
 */
export default new OAuthProvider({
  apiRoute: "/mcp",
  // 类型在不同版本间略有差异，用 as any 适配 ExportedHandler 形态。
  apiHandler: mcpApiHandler as never,
  defaultHandler: accessHandler as never,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
