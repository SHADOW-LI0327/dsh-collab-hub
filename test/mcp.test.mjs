import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { createHub } from '../lib/server.mjs';

test('mcp: initialize, list tools, read context and update status', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'collab-mcp-test-'));
  const hub = await createHub({ dataDir: join(dir, 'data'), port: 0, host: '127.0.0.1' });
  const address = await hub.start();
  const base = `http://127.0.0.1:${address.port}`;
  const registered = await (await fetch(`${base}/api/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'A', role: 'frontend' }),
  })).json();
  const auth = { authorization: `Bearer ${registered.token}`, 'content-type': 'application/json' };
  await fetch(`${base}/api/projects`, { method: 'POST', headers: auth, body: JSON.stringify({ id: 'p', name: 'P' }) });
  await fetch(`${base}/api/projects/p/features`, { method: 'POST', headers: auth, body: JSON.stringify({ id: 'F', title: 'T', brief: 'B' }) });
  const config = join(dir, 'collab.json');
  await writeFile(config, JSON.stringify({ hubUrl: base, token: registered.token, name: 'A', role: 'frontend' }));

  const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'mcp', 'server.mjs')], {
    env: { ...process.env, COLLAB_CONFIG: config },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(async () => {
    child.kill();
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  });

  const pending = new Map();
  let seq = 0;
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const message = JSON.parse(line);
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => reject(new Error(`timeout: ${method}`)), 5000).unref();
  });

  const init = await send('initialize', {});
  assert.equal(init.result.serverInfo.name, 'dsh-collab-hub');
  const tools = await send('tools/list', {});
  assert.equal(tools.result.tools.length, 10);
  assert.ok(tools.result.tools.some((tool) => tool.name === 'collab_context'));

  const context = await send('tools/call', { name: 'collab_context', arguments: { feature: 'F' } });
  assert.match(context.result.content[0].text, /Feature: F · T/);

  const status = await send('tools/call', { name: 'collab_status', arguments: { feature: 'F', state: 'implementing', focus: 'api' } });
  assert.match(status.result.content[0].text, /implementing/);

  const question = await send('tools/call', { name: 'collab_question', arguments: { feature: 'F', text: 'contract?' } });
  assert.match(question.result.content[0].text, /question q_/);
});
