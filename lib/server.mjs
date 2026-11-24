/**
 * HTTP hub: JSON API, file uploads, signed read URLs and the static board.
 *
 * Bind to a LAN address (for example `--host 0.0.0.0`) for team use; the
 * default is loopback. There is no TLS here — put Caddy/Nginx in front if the
 * network is not already trusted.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';

const MAX_FILE = 25 * 1024 * 1024;
const MAX_JSON = 1024 * 1024;
const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

const ALLOWED_MIME = new Set([
	'image/png',
	'image/jpeg',
	'image/webp',
	'image/gif',
	'text/html',
	'text/markdown',
	'text/plain',
	'application/pdf',
	'application/octet-stream',
]);

function httpError(status, message) {
	const error = new Error(message);
	error.status = status;
	return error;
}

function sendJson(res, value, status = 200) {
	const body = Buffer.from(JSON.stringify(value));
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': body.length,
		'cache-control': 'no-store',
		'x-content-type-options': 'nosniff',
	});
	res.end(body);
}

function sendText(res, value, status = 200, type = 'text/plain; charset=utf-8') {
	const body = Buffer.from(value);
	res.writeHead(status, {
		'content-type': type,
		'content-length': body.length,
		'cache-control': 'no-store',
		'x-content-type-options': 'nosniff',
	});
	res.end(body);
}

function header(req, name) {
	const value = req.headers[name];
	return Array.isArray(value) ? value[0] : value;
}

async function readBuffer(req, limit = MAX_FILE) {
	const declared = Number(header(req, 'content-length') ?? 0);
	if (Number.isFinite(declared) && declared > limit) throw httpError(413, 'body too large');
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > limit) throw httpError(413, 'body too large');
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

async function readJson(req) {
	const body = await readBuffer(req, MAX_JSON);
	if (body.length === 0) return {};
	try {
		const value = JSON.parse(body.toString('utf8'));
		if (value === null || typeof value !== 'object' || Array.isArray(value)) {
			throw new Error('body must be a JSON object');
		}
		return value;
	} catch (error) {
		throw httpError(400, `invalid JSON: ${error.message}`);
	}
}

function safeFilename(name) {
	return String(name || 'file')
		.replace(/[\u0000-\u001f\u007f/\\]/g, '_')
		.replace(/^\.+/, '')
		.slice(0, 180) || 'file';
}

function safeMime(value, filename) {
	const raw = String(value || '').split(';')[0].trim().toLowerCase();
	if (ALLOWED_MIME.has(raw)) return raw;
	const ext = extname(filename || '').toLowerCase();
	if (ext === '.md' || ext === '.markdown') return 'text/markdown';
	if (ext === '.html' || ext === '.htm') return 'text/html';
	if (ext === '.txt') return 'text/plain';
	if (ext === '.png') return 'image/png';
	if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
	if (ext === '.webp') return 'image/webp';
	if (ext === '.gif') return 'image/gif';
	if (ext === '.pdf') return 'application/pdf';
	return 'application/octet-stream';
}

async function readUpload(req, url) {
	const type = String(header(req, 'content-type') ?? '');
	if (type.startsWith('multipart/form-data')) {
		const request = new Request(`http://hub.local${url.pathname}`, {
			method: 'POST',
			headers: req.headers,
			body: Readable.toWeb(req),
			duplex: 'half',
		});
		const form = await request.formData();
		const file = form.get('file');
		if (!file || typeof file === 'string') throw httpError(400, 'multipart field "file" is required');
		const data = Buffer.from(await file.arrayBuffer());
		return {
			filename: safeFilename(file.name || form.get('filename')),
			mime: safeMime(file.type, file.name),
			kind: String(form.get('kind') ?? 'design'),
			summary: String(form.get('summary') ?? ''),
			data,
		};
	}
	const data = await readBuffer(req, MAX_FILE);
	return {
		filename: safeFilename(header(req, 'x-filename') ?? 'file'),
		mime: safeMime(header(req, 'content-type'), header(req, 'x-filename')),
		kind: String(header(req, 'x-kind') ?? 'design'),
		summary: String(header(req, 'x-summary') ?? ''),
		data,
	};
}

function sign(store, artifactId, expires) {
	return createHmac('sha256', store.state.secret).update(`${artifactId}.${expires}`).digest('base64url');
}

function verifySignature(store, artifactId, expires, signature) {
	const expected = sign(store, artifactId, expires);
	const a = Buffer.from(expected);
	const b = Buffer.from(String(signature ?? ''));
	return a.length === b.length && timingSafeEqual(a, b);
}

function artifactUrl(store, artifactId) {
	const expires = Date.now() + 10 * 60 * 1000;
	const signature = sign(store, artifactId, expires);
	return `/api/artifacts/${encodeURIComponent(artifactId)}/raw?exp=${expires}&sig=${encodeURIComponent(signature)}`;
}

function safeDisposition(filename) {
	return `inline; filename="${String(filename).replace(/["\\\r\n]/g, '_')}"`;
}

async function handle(req, res, store, logger) {
	const url = new URL(req.url, 'http://hub.local');
	const path = url.pathname;
	const method = req.method ?? 'GET';

	if (method === 'OPTIONS') {
		res.writeHead(204, { allow: 'GET,POST,OPTIONS' });
		res.end();
		return;
	}

	if (method === 'GET' && (path === '/' || path === '/index.html')) {
		const html = await readFile(join(PUBLIC_DIR, 'index.html'));
		res.writeHead(200, {
			'content-type': 'text/html; charset=utf-8',
			'content-length': html.length,
			'cache-control': 'no-store',
			'x-content-type-options': 'nosniff',
			'content-security-policy': "default-src 'self'; img-src 'self' data: https: http:; frame-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'",
		});
		res.end(html);
		return;
	}
	if (method === 'GET' && (path === '/app.js' || path === '/styles.css' || path === '/markdown.js')) {
		const file = path.slice(1);
		const body = await readFile(join(PUBLIC_DIR, file));
		res.writeHead(200, {
			'content-type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8',
			'content-length': body.length,
			'cache-control': 'no-store',
			'x-content-type-options': 'nosniff',
		});
		res.end(body);
		return;
	}

	if (path === '/api/health' && method === 'GET') {
		sendJson(res, { ok: true, service: 'dsh-collab-hub' });
		return;
	}

	if (path === '/api/register' && method === 'POST') {
		const body = await readJson(req);
		const result = await store.register(body.name, body.role);
		sendJson(res, result, 201);
		return;
	}

	const authorization = header(req, 'authorization') ?? '';
	const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
	const member = store.memberByToken(token);
	const isSignedRaw = method === 'GET' && /^\/api\/artifacts\/[^/]+\/raw$/.test(path);
	if (!member && !isSignedRaw) throw httpError(401, 'missing or invalid member token');
	const actor = member?.id;

	if (path === '/api/me' && method === 'GET') {
		sendJson(res, { member: store.publicMember(member) });
		return;
	}

	if (path === '/api/board' && method === 'GET') {
		sendJson(res, store.board());
		return;
	}

	if (path === '/api/projects' && method === 'GET') {
		sendJson(res, { projects: store.state.projects.map((project) => store.projectView(project)) });
		return;
	}

	if (path === '/api/projects' && method === 'POST') {
		const body = await readJson(req);
		const project = await store.createProject({
			id: body.id,
			name: body.name,
			description: body.description,
			repos: body.repos,
			ownerId: actor,
		});
		sendJson(res, project, 201);
		return;
	}

	let match = path.match(/^\/api\/projects\/([^/]+)$/);
	if (match && method === 'GET') {
		const project = store.projectById(decodeURIComponent(match[1]));
		if (!project) throw httpError(404, 'project not found');
		sendJson(res, store.projectView(project));
		return;
	}

	match = path.match(/^\/api\/projects\/([^/]+)\/features$/);
	if (match && method === 'POST') {
		const body = await readJson(req);
		const feature = await store.createFeature({
			projectId: decodeURIComponent(match[1]),
			id: body.id,
			title: body.title,
			repos: body.repos,
			brief: body.brief,
			ownerId: actor,
		});
		sendJson(res, feature, 201);
		return;
	}

	if (path === '/api/features' && method === 'GET') {
		const projectId = url.searchParams.get('project');
		const features = store.state.features
			.filter((feature) => !projectId || feature.projectId === projectId)
			.map((feature) => store.featureView(feature));
		sendJson(res, { features });
		return;
	}

	if (path === '/api/features' && method === 'POST') {
		const body = await readJson(req);
		const feature = await store.createFeature({
			projectId: body.projectId,
			id: body.id,
			title: body.title,
			repos: body.repos,
			brief: body.brief,
			ownerId: actor,
		});
		sendJson(res, feature, 201);
		return;
	}

	match = path.match(/^\/api\/features\/([^/]+)\/context$/);
	if (match && method === 'GET') {
		const since = Number(url.searchParams.get('since') ?? 0);
		sendJson(res, store.context(decodeURIComponent(match[1]), Number.isFinite(since) ? since : 0));
		return;
	}

	match = path.match(/^\/api\/features\/([^/]+)\/delta$/);
	if (match && method === 'GET') {
		const since = Number(url.searchParams.get('since') ?? 0);
		sendJson(res, store.delta(decodeURIComponent(match[1]), Number.isFinite(since) ? since : 0));
		return;
	}

	match = path.match(/^\/api\/features\/([^/]+)\/status$/);
	if (match && method === 'POST') {
		const body = await readJson(req);
		const status = await store.setStatus(decodeURIComponent(match[1]), actor, {
			state: body.state,
			focus: body.focus,
			blocker: body.blocker,
		});
		sendJson(res, status);
		return;
	}

	match = path.match(/^\/api\/features\/([^/]+)\/artifacts$/);
	if (match && method === 'POST') {
		const upload = await readUpload(req, url);
		const artifact = await store.publishArtifact(decodeURIComponent(match[1]), actor, upload);
		sendJson(res, { ...artifact, url: artifactUrl(store, artifact.id) }, 201);
		return;
	}

	match = path.match(/^\/api\/features\/([^/]+)\/questions$/);
	if (match && method === 'POST') {
		const body = await readJson(req);
		const question = await store.createQuestion(decodeURIComponent(match[1]), actor, body.text);
		sendJson(res, question, 201);
		return;
	}

	match = path.match(/^\/api\/features\/([^/]+)\/handoff$/);
	if (match && method === 'POST') {
		const body = await readJson(req);
		sendJson(res, await store.handoff(decodeURIComponent(match[1]), actor, body.note));
		return;
	}

	match = path.match(/^\/api\/questions\/([^/]+)\/answer$/);
	if (match && method === 'POST') {
		const body = await readJson(req);
		sendJson(res, await store.answerQuestion(decodeURIComponent(match[1]), actor, body.text));
		return;
	}

	match = path.match(/^\/api\/artifacts\/([^/]+)$/);
	if (match && method === 'GET') {
		const artifact = store.artifactById(decodeURIComponent(match[1]));
		if (!artifact) throw httpError(404, 'artifact not found');
		sendJson(res, { ...store.artifactView(artifact), url: artifactUrl(store, artifact.id) });
		return;
	}

	match = path.match(/^\/api\/artifacts\/([^/]+)\/url$/);
	if (match && method === 'GET') {
		const artifact = store.artifactById(decodeURIComponent(match[1]));
		if (!artifact) throw httpError(404, 'artifact not found');
		sendJson(res, { url: artifactUrl(store, artifact.id), expiresAt: Date.now() + 10 * 60 * 1000 });
		return;
	}

	match = path.match(/^\/api\/artifacts\/([^/]+)\/raw$/);
	if (match && method === 'GET') {
		const id = decodeURIComponent(match[1]);
		const artifact = store.artifactById(id);
		if (!artifact) throw httpError(404, 'artifact not found');
		const expires = Number(url.searchParams.get('exp') ?? 0);
		const signature = url.searchParams.get('sig');
		const signed = Number.isFinite(expires) && expires > Date.now() && verifySignature(store, id, expires, signature);
		if (!signed) throw httpError(401, 'invalid or expired signature');
		const bytes = await store.readArtifact(artifact);
		const headers = {
			'content-type': artifact.mime,
			'content-length': bytes.length,
			'content-disposition': safeDisposition(artifact.filename),
			'cache-control': 'private, max-age=60',
			'x-content-type-options': 'nosniff',
		};
		if (artifact.mime === 'text/html') {
			headers['content-security-policy'] = "sandbox allow-scripts; default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'";
		}
		res.writeHead(200, headers);
		res.end(bytes);
		return;
	}

	throw httpError(404, 'not found');
}

/** Create the hub and its HTTP server; call `start()` to listen. */
export async function createHub({ dataDir = './data', host = '127.0.0.1', port = 8787, logger = console } = {}) {
	const store = await new Store(dataDir).init();
	const server = createServer((req, res) => {
		handle(req, res, store, logger).catch((error) => {
			const status = Number.isInteger(error.status) ? error.status : 500;
			if (status >= 500) logger.error?.(error);
			if (!res.headersSent) sendJson(res, { error: error.message ?? String(error) }, status);
			else res.end();
		});
	});
	return {
		store,
		server,
		start() {
			return new Promise((resolve, reject) => {
				server.once('error', reject);
				server.listen(port, host, () => {
					server.off('error', reject);
					resolve(server.address());
				});
			});
		},
		close() {
			return new Promise((resolve) => server.close(() => resolve()));
		},
	};
}
