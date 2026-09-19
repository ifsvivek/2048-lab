/**
 * 2048 Platform MCP server — Hono on Cloudflare Workers, Streamable HTTP
 * transport, stateless: every request builds a fresh McpServer and transport,
 * so any isolate can serve any request and nothing is stored here. All game
 * state lives in the platform API (reached via the `API` service binding).
 *
 *   POST /mcp          JSON-RPC over Streamable HTTP (MCP 2025-06-18+)
 *   GET  /             server info + client configuration snippets
 */
import { StreamableHTTPTransport } from '@hono/mcp';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ApiClient, type Env } from './api.ts';
import { SERVER_INFO, buildServer } from './tools.ts';

const app = new Hono<{ Bindings: Env }>();

app.use(
  '*',
  cors({
    origin: '*',
    allowHeaders: ['content-type', 'authorization', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'],
    exposeHeaders: ['mcp-session-id', 'mcp-protocol-version'],
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  }),
);

app.get('/', (c) => {
  const url = new URL('/mcp', c.req.url).toString();
  return c.json({
    ...SERVER_INFO,
    transport: 'streamable-http',
    endpoint: url,
    stateless: true,
    docs: 'docs/MCP.md',
    clients: {
      claudeCode: `claude mcp add --transport http g2048 ${url}`,
      cursor: { mcpServers: { g2048: { url } } },
      windsurf: { mcpServers: { g2048: { serverUrl: url } } },
      codex: `[mcp_servers.g2048]\nurl = "${url}"`,
      cline: { mcpServers: { g2048: { type: 'streamableHttp', url } } },
      continue: { mcpServers: [{ name: 'g2048', type: 'streamable-http', url }] },
      stdioBridge: `npx -y mcp-remote ${url}`,
    },
  });
});

app.get('/health', (c) => c.json({ ok: true, ...SERVER_INFO }));

app.post('/mcp', async (c) => {
  // Stateless mode: no session IDs, one server + transport per request.
  const server = buildServer(new ApiClient(c.env, c.req.header('authorization') ?? null));
  const transport = new StreamableHTTPTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(c);
});

// Stateless servers offer no standalone SSE stream and no sessions to delete.
const notAllowed = () =>
  new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this server is stateless; use POST.' }, id: null }), {
    status: 405,
    headers: { 'content-type': 'application/json', allow: 'POST' },
  });
app.get('/mcp', notAllowed);
app.delete('/mcp', notAllowed);

export default app;
