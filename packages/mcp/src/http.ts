import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { KitContext } from "./context.js";
import { createServer } from "./server.js";

/**
 * Streamable HTTP transport (stateless: one McpServer + transport per request, as the SDK recommends), bound to
 * 127.0.0.1 by default. The server signs with a local key, so never expose it beyond localhost without your own
 * authentication in front of it.
 */
export function serveHttp(ctx: KitContext, opts: { port?: number; host?: string; path?: string } = {}) {
  const port = opts.port ?? 7402;
  const host = opts.host ?? "127.0.0.1";
  const path = opts.path ?? "/mcp";
  const http = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, chainId: ctx.chainId, account: ctx.account }));
      return;
    }
    if (url.pathname !== path) {
      res.writeHead(404).end("not found");
      return;
    }
    const server = createServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
  });
  http.listen(port, host, () => {
    process.stderr.write(`hedgehood-mcp: streamable HTTP on http://${host}:${port}${path} (chain ${ctx.chainId}, account ${ctx.account})\n`);
  });
  return http;
}
