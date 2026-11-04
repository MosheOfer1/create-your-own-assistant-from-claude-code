// A minimal MCP server over stdio (JSON-RPC, one message per line), so the gateway needs
// no SDK. tools: { name: { description, schema (JSON Schema), run(args) → text | object } }.
import readline from 'node:readline';

export function serve(name, tools) {
  const out = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  const list = Object.entries(tools).map(([n, t]) => ({ name: n, description: t.description, inputSchema: t.schema }));
  readline.createInterface({ input: process.stdin }).on('line', async (line) => {
    let req;
    try { req = JSON.parse(line); } catch { return; }
    const { id, method, params = {} } = req;
    if (id === undefined) return; // a notification
    if (method === 'initialize') {
      return out({ id, result: { protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name, version: '1.0.0' } } });
    }
    if (method === 'tools/list') return out({ id, result: { tools: list } });
    if (method === 'tools/call') {
      const tool = tools[params.name];
      if (!tool) return out({ id, error: { code: -32602, message: `unknown tool ${params.name}` } });
      try {
        const r = await tool.run(params.arguments || {});
        return out({ id, result: { content: [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r) }] } });
      } catch (e) {
        return out({ id, result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true } });
      }
    }
    if (method === 'ping') return out({ id, result: {} });
    return out({ id, error: { code: -32601, message: `unknown method ${method}` } });
  });
}

// POST to the gateway's control API with the token from the environment.
export async function ctl(route, body) {
  const r = await fetch(`${process.env.ASSISTANT_CTL_URL}${route}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.ASSISTANT_CTL_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`gateway answered ${r.status}`);
  return r.json();
}
