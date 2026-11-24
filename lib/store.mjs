/**
 * File-backed collaboration store.
 *
 * One JSON metadata file plus content-addressed blobs; a serial mutation queue
 * keeps concurrent HTTP writes consistent for a small (3–5 person) team.
 * Tokens are stored only as SHA-256 hashes.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

export const STATES = ['idle', 'designing', 'implementing', 'reviewing', 'blocked', 'done'];
export const KINDS = ['design', 'report', 'contract', 'note', 'other'];
const MAX_FILE = 25 * 1024 * 1024;
const MAX_TEXT = 4000;
const STALE_MS = 30 * 60 * 1000;

function fail(status, message) {
	const error = new Error(message);
	error.status = status;
	return error;
}

function tokenHash(token) {
	return createHash('sha256').update(token).digest('hex');
}

function newId(prefix) {
	return `${prefix}_${randomBytes(8).toString('hex')}`;
}

function cleanText(value, field, max = MAX_TEXT) {
	if (typeof value !== 'string') throw fail(400, `${field} must be a string`);
	const text = value.trim();
	if (text === '') throw fail(400, `${field} must not be empty`);
	if (text.length > max) throw fail(400, `${field} is too long`);
	return text;
}

function cleanName(value, field, max = 40) {
	const text = cleanText(value, field, max);
	if (/[\u0000-\u001f]/.test(text)) throw fail(400, `${field} contains control characters`);
	return text;
}

function cleanId(value, field) {
	const text = cleanText(value, field, 64);
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text)) {
		throw fail(400, `${field} must match [A-Za-z0-9][A-Za-z0-9._-]*`);
	}
	return text;
}

function cleanRepos(value, fallback = []) {
	const source = value === undefined || (Array.isArray(value) && value.length === 0) ? fallback : value;
	if (!Array.isArray(source)) throw fail(400, 'repos must be an array');
	const repos = [];
	for (const item of source) {
		if (typeof item !== 'string') throw fail(400, 'repos entries must be strings');
		const repo = item.trim();
		if (repo !== '' && !repos.includes(repo)) repos.push(repo.slice(0, 100));
	}
	return repos;
}

function emptyState() {
	return {
		version: 1,
		secret: randomBytes(32).toString('hex'),
		seq: 0,
		members: [],
		projects: [],
		features: [],
		statuses: [],
		artifacts: [],
		questions: [],
		events: [],
	};
}

export class Store {
	constructor(dataDir) {
		this.dataDir = dataDir;
		this.statePath = join(dataDir, 'state.json');
		this.blobDir = join(dataDir, 'blobs');
		this.state = null;
		this.queue = Promise.resolve();
	}

	async init() {
		await mkdir(this.blobDir, { recursive: true });
		try {
			this.state = JSON.parse(await readFile(this.statePath, 'utf8'));
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
			this.state = emptyState();
			await this.persist();
		}
		for (const key of ['members', 'projects', 'features', 'statuses', 'artifacts', 'questions', 'events']) {
			if (!Array.isArray(this.state[key])) this.state[key] = [];
		}
		if (typeof this.state.seq !== 'number') this.state.seq = 0;
		if (typeof this.state.secret !== 'string') {
			this.state.secret = randomBytes(32).toString('hex');
			await this.persist();
		}
		return this;
	}

	async persist() {
		const tmp = `${this.statePath}.${process.pid}.tmp`;
		await writeFile(tmp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
		await rename(tmp, this.statePath);
	}

	async mutate(fn) {
		const run = this.queue.then(async () => {
			const result = await fn();
			await this.persist();
			return result;
		});
		this.queue = run.catch(() => {});
		return run;
	}

	memberById(id) {
		return this.state.members.find((member) => member.id === id) ?? null;
	}

	memberByName(name) {
		const lowered = name.trim().toLowerCase();
		return this.state.members.find((member) => member.name.toLowerCase() === lowered) ?? null;
	}

	publicMember(member) {
		return { id: member.id, name: member.name, role: member.role, createdAt: member.createdAt };
	}

	memberByToken(token) {
		if (typeof token !== 'string' || !token.startsWith('col_')) return null;
		const digest = Buffer.from(tokenHash(token), 'hex');
		for (const member of this.state.members) {
			const candidate = Buffer.from(member.tokenHash, 'hex');
			if (candidate.length === digest.length && timingSafeEqual(candidate, digest)) return member;
		}
		return null;
	}

	/** Self-service registration: names are unique, a token is returned once. */
	async register(name, role) {
		const clean = cleanName(name, 'name');
		const cleanRole = role === undefined || role === '' ? 'member' : cleanName(role, 'role');
		if (this.memberByName(clean)) throw fail(409, `member "${clean}" already exists`);
		return this.mutate(async () => {
			const token = `col_${randomBytes(32).toString('hex')}`;
			const member = {
				id: newId('mem'),
				name: clean,
				role: cleanRole,
				tokenHash: tokenHash(token),
				createdAt: new Date().toISOString(),
			};
			this.state.members.push(member);
			return { member: this.publicMember(member), token };
		});
	}

	/** Offline admin reset: issue a new token for an existing member. */
	async resetToken(name) {
		const member = this.memberByName(name);
		if (!member) throw fail(404, `member "${name}" not found`);
		return this.mutate(async () => {
			const token = `col_${randomBytes(32).toString('hex')}`;
			member.tokenHash = tokenHash(token);
			return { member: this.publicMember(member), token };
		});
	}

	projectById(id) {
		return this.state.projects.find((project) => project.id === id) ?? null;
	}

	featureById(id) {
		return this.state.features.find((feature) => feature.id === id) ?? null;
	}

	projectView(project) {
		const owner = this.memberById(project.ownerId);
		const features = this.state.features.filter((feature) => feature.projectId === project.id);
		return {
			...project,
			owner: owner?.name ?? null,
			featureCount: features.length,
			features: features.map((feature) => this.featureView(feature)),
		};
	}

	featureView(feature) {
		const project = this.projectById(feature.projectId);
		const owner = this.memberById(feature.ownerId);
		return {
			...feature,
			projectName: project?.name ?? null,
			owner: owner?.name ?? null,
			statuses: this.state.statuses
				.filter((status) => status.featureId === feature.id)
				.map((status) => this.statusView(status)),
			openQuestions: this.state.questions.filter(
				(question) => question.featureId === feature.id && question.status === 'open',
			).length,
			artifactCount: this.state.artifacts.filter((artifact) => artifact.featureId === feature.id).length,
		};
	}

	statusView(status) {
		const member = this.memberById(status.memberId);
		const age = Date.now() - Date.parse(status.updatedAt);
		return {
			...status,
			member: member?.name ?? null,
			role: member?.role ?? null,
			stale: age > STALE_MS,
		};
	}

	artifactView(artifact) {
		const member = this.memberById(artifact.memberId);
		return { ...artifact, author: member?.name ?? null, role: member?.role ?? null };
	}

	questionView(question) {
		const author = this.memberById(question.authorId);
		const answerer = question.answeredBy ? this.memberById(question.answeredBy) : null;
		return {
			...question,
			author: author?.name ?? null,
			answeredByName: answerer?.name ?? null,
		};
	}

	event(type, { projectId, featureId = null, actorId, payload = {} }) {
		const event = {
			id: ++this.state.seq,
			type,
			projectId,
			featureId,
			actorId,
			payload,
			createdAt: new Date().toISOString(),
		};
		this.state.events.push(event);
		return event;
	}

	async createProject({ id, name, description = '', repos, ownerId }) {
		const projectId = cleanId(id, 'project id');
		if (this.projectById(projectId)) throw fail(409, `project "${projectId}" already exists`);
		const title = cleanName(name, 'name', 100);
		const detail = typeof description === 'string' ? description.trim().slice(0, 2000) : '';
		const repoList = cleanRepos(repos);
		return this.mutate(async () => {
			const project = {
				id: projectId,
				name: title,
				description: detail,
				repos: repoList,
				ownerId,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};
			this.state.projects.push(project);
			this.event('project.created', { projectId, actorId: ownerId, payload: { name: title } });
			return this.projectView(project);
		});
	}

	async createFeature({ projectId, id, title, repos, ownerId, brief = '' }) {
		const project = this.projectById(projectId);
		if (!project) throw fail(404, `project "${projectId}" not found`);
		const featureId = cleanId(id, 'feature id');
		if (this.featureById(featureId)) throw fail(409, `feature "${featureId}" already exists`);
		const name = cleanName(title, 'title', 160);
		const detail = typeof brief === 'string' ? brief.trim().slice(0, 4000) : '';
		const repoList = cleanRepos(repos, project.repos);
		return this.mutate(async () => {
			const feature = {
				id: featureId,
				projectId,
				title: name,
				repos: repoList,
				ownerId,
				brief: detail,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				revision: 1,
			};
			this.state.features.push(feature);
			project.updatedAt = feature.createdAt;
			this.event('feature.created', { projectId, featureId, actorId: ownerId, payload: { title: name } });
			return this.featureView(feature);
		});
	}

	async setStatus(featureId, memberId, { state, focus = '', blocker = '' }) {
		const feature = this.featureById(featureId);
		if (!feature) throw fail(404, `feature "${featureId}" not found`);
		if (!STATES.includes(state)) throw fail(400, `state must be one of ${STATES.join(', ')}`);
		const focusText = typeof focus === 'string' ? focus.trim().slice(0, 500) : '';
		const blockerText = typeof blocker === 'string' ? blocker.trim().slice(0, 500) : '';
		return this.mutate(async () => {
			const now = new Date().toISOString();
			let status = this.state.statuses.find(
				(item) => item.featureId === featureId && item.memberId === memberId,
			);
			if (!status) {
				status = { featureId, memberId, state, focus: focusText, blocker: blockerText, updatedAt: now };
				this.state.statuses.push(status);
			} else {
				status.state = state;
				status.focus = focusText;
				status.blocker = blockerText;
				status.updatedAt = now;
			}
			feature.updatedAt = now;
			feature.revision += 1;
			this.event('status.updated', {
				projectId: feature.projectId,
				featureId,
				actorId: memberId,
				payload: { state, focus: focusText, blocker: blockerText },
			});
			return this.statusView(status);
		});
	}

	async publishArtifact(featureId, memberId, { kind, filename, mime, data, summary }) {
		const feature = this.featureById(featureId);
		if (!feature) throw fail(404, `feature "${featureId}" not found`);
		if (!KINDS.includes(kind)) throw fail(400, `kind must be one of ${KINDS.join(', ')}`);
		const cleanFilename = basename(cleanText(filename, 'filename', 200)).replace(/[\u0000-\u001f]/g, '_');
		const type = typeof mime === 'string' && mime !== '' ? mime.slice(0, 120) : 'application/octet-stream';
		const summaryText = typeof summary === 'string' && summary.trim() !== ''
			? summary.trim().slice(0, 500)
			: cleanFilename;
		if (!Buffer.isBuffer(data) || data.length === 0) throw fail(400, 'file is empty');
		if (data.length > MAX_FILE) throw fail(413, `file exceeds ${MAX_FILE} bytes`);
		const digest = createHash('sha256').update(data).digest('hex');
		const blobPath = join(this.blobDir, digest);
		return this.mutate(async () => {
			try {
				await stat(blobPath);
			} catch (error) {
				if (error.code !== 'ENOENT') throw error;
				await writeFile(blobPath, data, { flag: 'wx' }).catch((writeError) => {
					if (writeError.code !== 'EEXIST') throw writeError;
				});
			}
			const version = this.state.artifacts.filter(
				(item) => item.featureId === featureId && item.memberId === memberId && item.filename === cleanFilename,
			).length + 1;
			const artifact = {
				id: newId('art'),
				featureId,
				memberId,
				kind,
				filename: cleanFilename,
				mime: type,
				size: data.length,
				sha256: digest,
				summary: summaryText,
				version,
				createdAt: new Date().toISOString(),
			};
			this.state.artifacts.push(artifact);
			feature.updatedAt = artifact.createdAt;
			feature.revision += 1;
			this.event('artifact.published', {
				projectId: feature.projectId,
				featureId,
				actorId: memberId,
				payload: {
					artifactId: artifact.id,
					kind,
					filename: cleanFilename,
					summary: summaryText,
					version,
				},
			});
			return this.artifactView(artifact);
		});
	}

	artifactById(id) {
		return this.state.artifacts.find((artifact) => artifact.id === id) ?? null;
	}

	artifactPath(artifact) {
		return join(this.blobDir, artifact.sha256);
	}

	async readArtifact(artifact) {
		return readFile(this.artifactPath(artifact));
	}

	async createQuestion(featureId, memberId, text) {
		const feature = this.featureById(featureId);
		if (!feature) throw fail(404, `feature "${featureId}" not found`);
		const body = cleanText(text, 'text', 2000);
		return this.mutate(async () => {
			const question = {
				id: newId('q'),
				featureId,
				authorId: memberId,
				text: body,
				status: 'open',
				answer: '',
				answeredBy: null,
				createdAt: new Date().toISOString(),
				answeredAt: null,
			};
			this.state.questions.push(question);
			feature.updatedAt = question.createdAt;
			feature.revision += 1;
			this.event('question.created', {
				projectId: feature.projectId,
				featureId,
				actorId: memberId,
				payload: { questionId: question.id, text: body },
			});
			return this.questionView(question);
		});
	}

	async answerQuestion(questionId, memberId, text) {
		const question = this.state.questions.find((item) => item.id === questionId);
		if (!question) throw fail(404, `question "${questionId}" not found`);
		if (question.status !== 'open') throw fail(409, 'question is already answered');
		const body = cleanText(text, 'text', 2000);
		const feature = this.featureById(question.featureId);
		return this.mutate(async () => {
			question.status = 'answered';
			question.answer = body;
			question.answeredBy = memberId;
			question.answeredAt = new Date().toISOString();
			if (feature) {
				feature.updatedAt = question.answeredAt;
				feature.revision += 1;
			}
			this.event('question.answered', {
				projectId: feature?.projectId,
				featureId: question.featureId,
				actorId: memberId,
				payload: { questionId, answer: body },
			});
			return this.questionView(question);
		});
	}

	async handoff(featureId, memberId, note) {
		const feature = this.featureById(featureId);
		if (!feature) throw fail(404, `feature "${featureId}" not found`);
		const body = cleanText(note, 'note', 2000);
		return this.mutate(async () => {
			this.event('handoff', {
				projectId: feature.projectId,
				featureId,
				actorId: memberId,
				payload: { note: body },
			});
			feature.updatedAt = new Date().toISOString();
			feature.revision += 1;
			return { featureId, note: body };
		});
	}

	context(featureId, since = 0) {
		const feature = this.featureById(featureId);
		if (!feature) throw fail(404, `feature "${featureId}" not found`);
		const project = this.projectById(feature.projectId);
		const statuses = this.state.statuses
			.filter((status) => status.featureId === featureId)
			.map((status) => this.statusView(status));
		const artifacts = this.state.artifacts
			.filter((artifact) => artifact.featureId === featureId)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.map((artifact) => this.artifactView(artifact));
		const questions = this.state.questions
			.filter((question) => question.featureId === featureId)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.slice(0, 50)
			.map((question) => this.questionView(question));
		const from = Number.isFinite(since) && since > 0 ? since : 0;
		const events = this.state.events
			.filter((event) => event.featureId === featureId && event.id > from)
			.slice(-50);
		return {
			generatedAt: new Date().toISOString(),
			cursor: this.state.seq,
			project: project ? { id: project.id, name: project.name, repos: project.repos } : null,
			feature: this.featureView(feature),
			members: this.state.members.map((member) => this.publicMember(member)),
			statuses,
			artifacts,
			questions,
			events,
		};
	}

	delta(featureId, since = 0) {
		const feature = this.featureById(featureId);
		if (!feature) throw fail(404, `feature "${featureId}" not found`);
		const from = Number.isFinite(since) && since > 0 ? since : 0;
		const events = this.state.events
			.filter((event) => event.featureId === featureId && event.id > from)
			.slice(-100);
		return { featureId, cursor: this.state.seq, events };
	}

	board() {
		const projects = this.state.projects.map((project) => {
			const owner = this.memberById(project.ownerId);
			const features = this.state.features
				.filter((feature) => feature.projectId === project.id)
				.map((feature) => this.featureView(feature));
			return {
				id: project.id,
				name: project.name,
				description: project.description,
				repos: project.repos,
				owner: owner?.name ?? null,
				createdAt: project.createdAt,
				updatedAt: project.updatedAt,
				features,
			};
		});
		return {
			generatedAt: new Date().toISOString(),
			members: this.state.members.map((member) => this.publicMember(member)),
			projects,
		};
	}
}
