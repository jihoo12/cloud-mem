import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "./server";

export interface Env {
  DB: D1Database;
  AUTH_TOKEN?: string;
}

function error(status: number, message: string, headers: HeadersInit = {}) {
  return Response.json({ error: message }, { status, headers });
}

async function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
}

/** Hashing first gives timingSafeEqual the equal-length inputs it requires. */
async function isAuthorized(request: Request, token: string): Promise<boolean> {
  const header = request.headers.get("Authorization") ?? "";
  const [actual, expected] = await Promise.all([
    sha256(header),
    sha256(`Bearer ${token}`),
  ]);
  return crypto.subtle.timingSafeEqual(actual, expected);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== "/mcp") {
      return error(404, "Not found");
    }
    if (!env.AUTH_TOKEN) {
      return error(503, "AUTH_TOKEN is not configured");
    }
    if (!(await isAuthorized(request, env.AUTH_TOKEN))) {
      return error(401, "Unauthorized", { "WWW-Authenticate": "Bearer" });
    }
    // Stateless: there are no sessions to resume or server-sent events to
    // stream, so only POST is served.
    if (request.method !== "POST") {
      return error(405, "Method not allowed", { Allow: "POST" });
    }

    const device = request.headers.get("X-Device")?.slice(0, 64) || undefined;
    const server = createServer(env.DB, device);
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
} satisfies ExportedHandler<Env>;
