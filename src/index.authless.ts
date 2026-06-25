import { createMcpHandler } from "agents/mcp";
import { buildMcpServer } from "./mcp";
import type { Env } from "./types";

/**
 * ⚠️ 仅用于 Phase 1 验证：无认证暴露 MCP 端点，便于跑通 OPS 数据链路。
 * 验证完成后改回 src/index.ts（OAuth 版本）部署，勿长期暴露此入口。
 *
 * 临时部署：把 wrangler.jsonc 的 "main" 指向本文件 → wrangler deploy。
 */
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "") {
      return Promise.resolve(
        new Response("Patent MCP Server (AUTHLESS dev mode). MCP endpoint: /mcp", {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }),
      );
    }
    const server = buildMcpServer(env);
    return createMcpHandler(server)(request, env, ctx);
  },
};
