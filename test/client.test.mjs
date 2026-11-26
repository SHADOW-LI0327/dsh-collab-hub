import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HubClient } from '../lib/client.mjs';
import { createHub } from '../lib/server.mjs';

test('client: publish keeps non-Latin1 summary and filename out of HTTP headers', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'collab-client-test-'));
  const hub = await createHub({ dataDir: join(dir, 'data'), port: 0, host: '127.0.0.1' });
  const { port } = await hub.start();
  t.after(async () => {
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  });

  const client = new HubClient({ hubUrl: `http://127.0.0.1:${port}` });
  const registered = await client.register('设计师', 'designer');
  client.token = registered.token;

  await client.createProject({ id: 'shop', name: '商城' });
  await client.createFeature({ projectId: 'shop', id: 'FEAT-001', title: '退款弹窗' });

  // Regression: these used to travel as x-summary / x-filename headers, and fetch
  // threw "Cannot convert argument to a ByteString ... greater than 255".
  const summary = '退款弹窗三态 + 空态 ✅';
  const filename = '退款弹窗设计.md';
  const file = join(dir, filename);
  await writeFile(file, '# 退款弹窗\n\n三态：全额 / 部分 / 空态。\n');

  const artifact = await client.publish('FEAT-001', file, { kind: 'design', summary });
  assert.equal(artifact.summary, summary);
  assert.equal(artifact.filename, filename);
  assert.equal(artifact.mime, 'text/markdown');
  assert.equal(artifact.version, 1);

  const raw = await fetch(client.absoluteUrl(artifact.url));
  assert.equal(raw.status, 200);
  assert.match(raw.headers.get('content-disposition'), /filename\*=UTF-8''/);
  assert.match(raw.headers.get('content-disposition'), new RegExp(encodeURIComponent(filename)));
  assert.match(await raw.text(), /三态/);

  const context = await client.context('FEAT-001');
  const published = context.artifacts.find((entry) => entry.id === artifact.id);
  assert.equal(published.summary, summary);
  assert.equal(published.filename, filename);
});

test('client: publish still accepts an empty summary (server falls back to the filename)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'collab-client-test-'));
  const hub = await createHub({ dataDir: join(dir, 'data'), port: 0, host: '127.0.0.1' });
  const { port } = await hub.start();
  t.after(async () => {
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  });

  const client = new HubClient({ hubUrl: `http://127.0.0.1:${port}` });
  const registered = await client.register('A', 'frontend');
  client.token = registered.token;
  await client.createProject({ id: 'p', name: 'P' });
  await client.createFeature({ projectId: 'p', id: 'F', title: 'T' });

  const file = join(dir, 'note.md');
  await writeFile(file, 'note\n');
  const artifact = await client.publish('F', file);
  assert.equal(artifact.summary, 'note.md');
});
