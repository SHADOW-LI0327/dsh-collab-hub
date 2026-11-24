import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHub } from '../lib/server.mjs';

async function json(response) {
  return { status: response.status, body: await response.json() };
}

test('hub: register, project, feature, status, artifacts, questions, board', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'collab-hub-test-'));
  const hub = await createHub({ dataDir: join(dir, 'data'), port: 0, host: '127.0.0.1' });
  const address = await hub.start();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  });

  const unauth = await fetch(`${base}/api/board`);
  assert.equal(unauth.status, 401);

  const registered = await json(await fetch(`${base}/api/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'A', role: 'frontend' }),
  }));
  assert.equal(registered.status, 201);
  assert.match(registered.body.token, /^col_/);
  const token = registered.body.token;

  const duplicate = await fetch(`${base}/api/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'a', role: 'x' }),
  });
  assert.equal(duplicate.status, 409);

  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const project = await json(await fetch(`${base}/api/projects`, {
    method: 'POST', headers: auth, body: JSON.stringify({ id: 'shop', name: 'Shop', repos: ['web', 'api'] }),
  }));
  assert.equal(project.status, 201);
  assert.deepEqual(project.body.repos, ['web', 'api']);

  const feature = await json(await fetch(`${base}/api/projects/shop/features`, {
    method: 'POST', headers: auth, body: JSON.stringify({ id: 'FEAT-001', title: 'Refund', brief: 'full/partial refund' }),
  }));
  assert.equal(feature.status, 201);
  assert.deepEqual(feature.body.repos, ['web', 'api']);

  const status = await json(await fetch(`${base}/api/features/FEAT-001/status`, {
    method: 'POST', headers: auth, body: JSON.stringify({ state: 'designing', focus: 'modal' }),
  }));
  assert.equal(status.status, 200);
  assert.equal(status.body.state, 'designing');

  const markdown = Buffer.from('# Refund\n\nThree states.\n');
  const artifact = await json(await fetch(`${base}/api/features/FEAT-001/artifacts`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'text/markdown',
      'x-filename': 'refund.md',
      'x-kind': 'design',
      'x-summary': 'three states',
    },
    body: markdown,
  }));
  assert.equal(artifact.status, 201);
  assert.equal(artifact.body.mime, 'text/markdown');
  assert.equal(artifact.body.version, 1);

  const raw = await fetch(`${base}${artifact.body.url}`);
  assert.equal(raw.status, 200);
  assert.equal(raw.headers.get('content-type'), 'text/markdown');
  assert.match(await raw.text(), /Three states/);

  const tampered = await fetch(`${base}${artifact.body.url.replace(/sig=[^&]+/, 'sig=x')}`);
  assert.equal(tampered.status, 401);

  const html = Buffer.from('<h1>Refund</h1><script>document.body.append("ok")</script>');
  const htmlArtifact = await json(await fetch(`${base}/api/features/FEAT-001/artifacts`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'text/html',
      'x-filename': 'refund.html',
      'x-kind': 'design',
      'x-summary': 'html design',
    },
    body: html,
  }));
  const htmlRaw = await fetch(`${base}${htmlArtifact.body.url}`);
  assert.equal(htmlRaw.status, 200);
  assert.match(htmlRaw.headers.get('content-security-policy'), /sandbox/);

  const form = new FormData();
  form.append('file', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'shot.png');
  form.append('kind', 'design');
  form.append('summary', 'screenshot');
  const image = await json(await fetch(`${base}/api/features/FEAT-001/artifacts`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form,
  }));
  assert.equal(image.status, 201);
  assert.equal(image.body.mime, 'image/png');

  const question = await json(await fetch(`${base}/api/features/FEAT-001/questions`, {
    method: 'POST', headers: auth, body: JSON.stringify({ text: 'partial refund?' }),
  }));
  assert.equal(question.status, 201);
  const answer = await json(await fetch(`${base}/api/questions/${question.body.id}/answer`, {
    method: 'POST', headers: auth, body: JSON.stringify({ text: 'yes, without approval' }),
  }));
  assert.equal(answer.status, 200);
  assert.equal(answer.body.status, 'answered');

  const context = await json(await fetch(`${base}/api/features/FEAT-001/context`, { headers: auth }));
  assert.equal(context.status, 200);
  assert.equal(context.body.statuses.length, 1);
  assert.equal(context.body.artifacts.length, 3);
  assert.equal(context.body.questions.length, 1);
  assert.ok(context.body.cursor >= 1);

  const delta = await json(await fetch(`${base}/api/features/FEAT-001/delta?since=${context.body.cursor}`, { headers: auth }));
  assert.equal(delta.body.events.length, 0);

  const board = await json(await fetch(`${base}/api/board`, { headers: auth }));
  assert.equal(board.status, 200);
  assert.equal(board.body.projects.length, 1);
  assert.equal(board.body.projects[0].features.length, 1);
});
