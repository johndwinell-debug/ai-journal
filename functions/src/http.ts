import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildServer } from './mcp.js';
import type { Store } from './store.js';

type Req = IncomingMessage & { body?: unknown; query?: Record<string, unknown> };

function keyMatches(given: string | undefined, expected: string): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res: ServerResponse, status: number, message: string) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

// Handles one connector request. Stateless: a fresh server per request, so it
// runs happily on serverless functions.
export async function handleConnector(req: Req, res: ServerResponse, store: Store, connectorKey: string) {
  const header = req.headers['authorization'];
  const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
  const fromQuery = typeof req.query?.key === 'string' ? (req.query.key as string) : undefined;
  if (!keyMatches(bearer ?? fromQuery, connectorKey)) {
    return send(res, 401, 'Missing or wrong connector key.');
  }
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    return send(res, 405, 'This connector accepts POST only.');
  }
  const server = buildServer(store);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('connector error', err);
    if (!res.headersSent) send(res, 500, 'The journal connector hit an internal error.');
  }
}
