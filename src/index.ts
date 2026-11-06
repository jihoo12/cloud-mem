import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { env as workerEnv } from "cloudflare:workers";
import { authHandler, type AuthEnv } from "./auth";
import { createServer } from "./server";

export interface Env extends AuthEnv {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
}

/** Only reached with a valid access token; OAuthProvider rejects everything else. */
const mcpHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Stateless: there are no sessions to resume or server-sent events to
    // stream, so only POST is served.
    if (request.method !== "POST") {
      return Response.json(
        { error: "Method not allowed" },
        { status: 405, headers: { Allow: "POST" } },
      );
    }

    const device = request.headers.get("X-Device")?.slice(0, 64) || undefined;
    const server = createServer(env.DB, device);
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};

const { PUBLIC_ORIGIN } = workerEnv as unknown as { PUBLIC_ORIGIN: string };

export default new OAuthProvider<Env>({
  resourceMetadata: {
    resource: `${PUBLIC_ORIGIN}/mcp`,
    authorization_servers: [PUBLIC_ORIGIN],
    bearer_methods_supported: ["header"],
    resource_name: "cloud-mem",
  },
  apiRoute: "/mcp",
  apiHandler: mcpHandler,
  defaultHandler: authHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
