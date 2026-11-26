import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../lib/server.mjs';

test('streamable HTTP MCP: initialize, tools/list, tools/call', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'collab-mcp-http-'));
  const hub = await createHub({ dataDir: join(dir, 'data'), port: 0, host: '127.0.0.1' });
  const address = await hub.start();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  });

  const reg = await (await fetch(`${base}/api/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'A', role: 'test' }),
  })).json();
  const auth = { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' };
  await fetch(`${base}/api/projects`, { method: 'POST', headers: auth, body: JSON.stringify({ id: 'p', name: 'P' }) });
  await fetch(`${base}/api/projects/p/features`, { method: 'POST', headers: auth, body: JSON.stringify({ id: 'F', title: 'T' }) });

  const rpc = async (body, token = reg.token) => {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(init.status, 200);
  assert.equal(init.body.result.serverInfo.name, 'dsh-collab-hub');
  const tools = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.ok(tools.body.result.tools.some((tool) => tool.name === 'collab_context'));
  const call = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'collab_context', arguments: { feature: 'F' } } });
  assert.match(call.body.result.content[0].text, /Feature: F/);

  const denied = await fetch(`${base}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }),
  });
  assert.equal(denied.status, 401);
});
