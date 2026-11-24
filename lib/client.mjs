/**
 * Small Hub client shared by the CLI, MCP server and the DSH plugin.
 * Credentials live in ~/.dsh/collab.json (mode 0600) or COLLAB_* env vars.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';

export const DEFAULT_HUB = 'http://127.0.0.1:8787';

export function configPath() {
	return process.env.COLLAB_CONFIG ?? join(homedir(), '.dsh', 'collab.json');
}

export async function loadConfig() {
	let file = {};
	try {
		file = JSON.parse(await readFile(configPath(), 'utf8'));
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
	}
	return {
		hubUrl: process.env.COLLAB_HUB_URL ?? file.hubUrl ?? DEFAULT_HUB,
		token: process.env.COLLAB_TOKEN ?? file.token ?? '',
		name: process.env.COLLAB_NAME ?? file.name ?? '',
		role: file.role ?? '',
	};
}

export async function saveConfig(patch) {
	const path = configPath();
	await mkdir(dirname(path), { recursive: true });
	let current = {};
	try {
		current = JSON.parse(await readFile(path, 'utf8'));
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
	}
	const next = { ...current, ...patch };
	await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
	await chmod(path, 0o600).catch(() => {});
	return next;
}

function mimeFor(filename) {
	const ext = extname(filename).toLowerCase();
	return (
		{
			'.png': 'image/png',
			'.jpg': 'image/jpeg',
			'.jpeg': 'image/jpeg',
			'.webp': 'image/webp',
			'.gif': 'image/gif',
			'.html': 'text/html',
			'.htm': 'text/html',
			'.md': 'text/markdown',
			'.markdown': 'text/markdown',
			'.txt': 'text/plain',
			'.pdf': 'application/pdf',
		}[ext] ?? 'application/octet-stream'
	);
}

export class HubClient {
	constructor({ hubUrl = DEFAULT_HUB, token = '', name = '' } = {}) {
		this.hubUrl = hubUrl.replace(/\/+$/, '');
		this.token = token;
		this.name = name;
	}

	static async fromConfig(overrides = {}) {
		return new HubClient({ ...(await loadConfig()), ...overrides });
	}

	url(path) {
		return `${this.hubUrl}${path.startsWith('/') ? path : `/${path}`}`;
	}

	async request(method, path, { json, body, headers = {}, raw = false } = {}) {
		const finalHeaders = { ...headers };
		if (this.token) finalHeaders.authorization = `Bearer ${this.token}`;
		if (json !== undefined) {
			finalHeaders['content-type'] = 'application/json';
			body = JSON.stringify(json);
		}
		const response = await fetch(this.url(path), { method, headers: finalHeaders, body });
		if (!response.ok) {
			let message = `HTTP ${response.status}`;
			try {
				const payload = await response.json();
				if (payload?.error) message = payload.error;
			} catch {
				// keep the status line
			}
			const error = new Error(message);
			error.status = response.status;
			throw error;
		}
		return raw ? response : response.json();
	}

	register(name, role) {
		return this.request('POST', '/api/register', { json: { name, role } });
	}

	me() {
		return this.request('GET', '/api/me');
	}

	board() {
		return this.request('GET', '/api/board');
	}

	projects() {
		return this.request('GET', '/api/projects');
	}

	createProject({ id, name, description, repos }) {
		return this.request('POST', '/api/projects', { json: { id, name, description, repos } });
	}

	project(id) {
		return this.request('GET', `/api/projects/${encodeURIComponent(id)}`);
	}

	createFeature({ projectId, id, title, repos, brief }) {
		return this.request('POST', `/api/projects/${encodeURIComponent(projectId)}/features`, {
			json: { id, title, repos, brief },
		});
	}

	features(projectId) {
		const query = projectId ? `?project=${encodeURIComponent(projectId)}` : '';
		return this.request('GET', `/api/features${query}`);
	}

	context(featureId, since = 0) {
		const query = since ? `?since=${encodeURIComponent(since)}` : '';
		return this.request('GET', `/api/features/${encodeURIComponent(featureId)}/context${query}`);
	}

	delta(featureId, since = 0) {
		const query = since ? `?since=${encodeURIComponent(since)}` : '';
		return this.request('GET', `/api/features/${encodeURIComponent(featureId)}/delta${query}`);
	}

	status(featureId, { state, focus, blocker }) {
		return this.request('POST', `/api/features/${encodeURIComponent(featureId)}/status`, {
			json: { state, focus, blocker },
		});
	}

	async publish(featureId, filePath, { kind = 'design', summary = '' } = {}) {
		const data = await readFile(filePath);
		const filename = basename(filePath);
		return this.request('POST', `/api/features/${encodeURIComponent(featureId)}/artifacts`, {
			body: data,
			headers: {
				'content-type': mimeFor(filename),
				'x-filename': filename,
				'x-kind': kind,
				'x-summary': summary,
			},
		});
	}

	question(featureId, text) {
		return this.request('POST', `/api/features/${encodeURIComponent(featureId)}/questions`, { json: { text } });
	}

	answer(questionId, text) {
		return this.request('POST', `/api/questions/${encodeURIComponent(questionId)}/answer`, { json: { text } });
	}

	handoff(featureId, note) {
		return this.request('POST', `/api/features/${encodeURIComponent(featureId)}/handoff`, { json: { note } });
	}

	artifact(id) {
		return this.request('GET', `/api/artifacts/${encodeURIComponent(id)}`);
	}

	artifactUrl(id) {
		return this.request('GET', `/api/artifacts/${encodeURIComponent(id)}/url`);
	}

	absoluteUrl(path) {
		return this.url(path);
	}

	async downloadArtifact(id) {
		const { url } = await this.artifactUrl(id);
		const response = await fetch(this.url(url));
		if (!response.ok) throw new Error(`artifact download failed: HTTP ${response.status}`);
		return response;
	}
}
