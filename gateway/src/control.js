import crypto from 'node:crypto';
import http from 'node:http';

// The control API: 127.0.0.1 only, a bearer token, JSON POST routes. The approval MCP server
// calls POST /approval, and the request stays open until the owner answers. Modules add routes
// ({ '/schedule': (body) => result }). port 0 = any free port; the URL is returned.
export async function startControl({ token, routes, port = 0 }) {
  const want = Buffer.from(`Bearer ${token}`);
  const server = http.createServer(async (req, res) => {
    const got = Buffer.from(req.headers.authorization || '');
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return res.writeHead(401).end();
    const handler = Object.hasOwn(routes, req.url) && routes[req.url];
    if (req.method !== 'POST' || !handler) return res.writeHead(404).end();
    let body = '';
    for await (const c of req) body += c;
    try {
      const result = await handler(JSON.parse(body || '{}'));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result ?? {}));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ allow: false, error: e.message }));
    }
  });
  server.requestTimeout = 0; // an approval may wait many minutes
  server.headersTimeout = 30_000;
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

export const newToken = () => crypto.randomBytes(24).toString('hex');
