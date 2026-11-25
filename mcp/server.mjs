#!/usr/bin/env node
/**
 * collab-mcp — stdio MCP server for non-DSH agents.
 *
 * DSH itself can use the same tools through the process-kit plugin; this entry
 * exists so Claude/Codex/other MCP clients can share the same feature context.
 * Diagnostics go to stderr only; stdout is the JSON-RPC channel.
 */
import { createInterface } from 'node:readline';
import { HubClient, loadConfig, saveConfig } from '../lib/client.mjs';
import { formatContext, formatDelta } from '../lib/format.mjs';

const NAME = 'dsh-collab-hub';
const VERSION = '0.1.0';

const TOOLS = [
	{
		name: 'collab_register',
		description: 'Register this member with the intranet collaboration hub (no admin approval) and save the token locally. Call once per machine.',
		inputSchema: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'Member name, unique in the hub' },
				role: { type: 'string', description: 'Role, e.g. frontend / backend / pm' },
				hubUrl: { type: 'string', description: 'Hub base URL; defaults to config/env' },
			},
			required: ['name'],
			additionalProperties: false,
		},
	},
	{
		name: 'collab_context',
		description: 'Read the shared feature context: project, member statuses, open questions, artifact index and recent changes. Call this before starting work so you do not repeat what the other side already decided.',
		inputSchema: {
			type: 'object',
			properties: {
				feature: { type: 'string' },
				since: { type: 'number', description: 'Only return events after this cursor' },
			},
			required: ['feature'],
			additionalProperties: false,
		},
	},
	{
		name: 'collab_delta',
		description: 'Read only the changes since a cursor. Use after a pause to see what the other member published or asked.',
		inputSchema: {
			type: 'object',
			properties: { feature: { type: 'string' }, since: { type: 'number' } },
			required: ['feature'],
			additionalProperties: false,
		},
	},
	{
		name: 'collab_publish',
		description: 'Publish a design/report artifact (image, HTML or Markdown) to the feature and record a short summary. Artifacts are immutable versions; do not overwrite the other side.',
		inputSchema: {
			type: 'object',
			properties: {
				feature: { type: 'string' },
				path: { type: 'string', description: 'Local file path' },
				kind: { type: 'string', enum: ['design', 'report', 'contract', 'note', 'other'] },
				summary: { type: 'string', description: 'Three-line summary for the other agent; do not paste the whole file' },
			},
			required: ['feature', 'path', 'summary'],
			additionalProperties: false,
		},
	},
	{
		name: 'collab_status',
		description: 'Update what you are doing on this feature: state, current focus and blocker. Call at start, after a milestone and before stopping.',
		inputSchema: {
			type: 'object',
			properties: {
				feature: { type: 'string' },
				state: { type: 'string', enum: ['idle', 'designing', 'implementing', 'reviewing', 'blocked', 'done'] },
				focus: { type: 'string' },
				blocker: { type: 'string' },
			},
			required: ['feature', 'state'],
			additionalProperties: false,
		},
	},
	{
		name: 'collab_question',
		description: 'Leave a question for the other member/agent on this feature. Use this instead of guessing at a design decision.',
		inputSchema: {
			type: 'object',
			properties: { feature: { type: 'string' }, text: { type: 'string' } },
			required: ['feature', 'text'],
			additionalProperties: false,
		},
	},
	{
		name: 'collab_answer',
		description: 'Answer an open question on the feature.',
		inputSchema: {
			type: 'object',
			properties: { question: { type: 'string' }, text: { type: 'string' } },
			required: ['question', 'text'],
			additionalProperties: false,
		},
	},
	{
		name: 'collab_handoff',
		description: 'Record a handoff note: what changed, what is next, what is risky. Use before stopping for the day or transferring work.',
		inputSchema: {
			type: 'object',
			properties: { feature: { type: 'string' }, note: { type: 'string' } },
			required: ['feature', 'note'],
			additionalProperties: false,
		},
	},
	{
		name: 'collab_project_create',
		description: 'Create a collaboration project (a product with one or more repos). Usually done once by a lead.',
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'string' },
				name: { type: 'string' },
				repos: { type: 'array', items: { type: 'string' } },
				description: { type: 'string' },
			},
			required: ['id', 'name'],
			additionalProperties: false,
		},
	},
	{
		name: 'collab_project_archive',
		description: 'Archive or restore a project. Archived projects are hidden from the default board but keep all data; use this instead of deleting.',
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'string' },
				archived: { type: 'boolean', description: 'true to archive (default), false to restore' },
			},
			required: ['id'],
			additionalProperties: false,
		},
	},
	{
		name: 'collab_feature_archive',
		description: 'Archive or restore a feature. Archived features are hidden from the default board and become read-only; use this instead of deleting.',
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'string' },
				archived: { type: 'boolean', description: 'true to archive (default), false to restore' },
			},
			required: ['id'],
			additionalProperties: false,
		},
	},
	{
		name: 'collab_feature_create',
		description: 'Create a feature under a project. The feature id is the shared handle both sides use.',
		inputSchema: {
			type: 'object',
			properties: {
				project: { type: 'string' },
				id: { type: 'string' },
				title: { type: 'string' },
				repos: { type: 'array', items: { type: 'string' } },
				brief: { type: 'string' },
			},
			required: ['project', 'id', 'title'],
			additionalProperties: false,
		},
	},
];

async function getClient(overrides = {}) {
	const config = await loadConfig();
	return new HubClient({ ...config, ...overrides });
}

function text(value, isError = false) {
	return { content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) };
}

async function callTool(name, args) {
	if (name === 'collab_register') {
		const config = await loadConfig();
		const hubUrl = args.hubUrl ?? config.hubUrl;
		const instance = new HubClient({ hubUrl });
		const result = await instance.register(args.name, args.role);
		await saveConfig({
			hubUrl,
			name: result.member.name,
			role: result.member.role,
			token: result.token,
		});
		return text(`registered ${result.member.name} (${result.member.role}); token saved locally`);
	}

	const instance = await getClient();
	if (!instance.token) {
		return text(`not registered; run collab_register({name:"..."}) or: collab register --name <you> --hub ${instance.hubUrl}`, true);
	}

	switch (name) {
		case 'collab_context': {
			const ctx = await instance.context(args.feature, Number(args.since ?? 0));
			return text(formatContext(ctx));
		}
		case 'collab_delta': {
			const delta = await instance.delta(args.feature, Number(args.since ?? 0));
			return text(formatDelta(delta));
		}
		case 'collab_publish': {
			const artifact = await instance.publish(args.feature, args.path, {
				kind: args.kind ?? 'design',
				summary: args.summary,
			});
			return text(`published ${artifact.filename} v${artifact.version} (${artifact.kind}) as ${artifact.id}\n${instance.absoluteUrl(artifact.url)}`);
		}
		case 'collab_status': {
			const status = await instance.status(args.feature, {
				state: args.state,
				focus: args.focus ?? '',
				blocker: args.blocker ?? '',
			});
			return text(`${status.member}: ${status.state}${status.focus ? ` · ${status.focus}` : ''}`);
		}
		case 'collab_question': {
			const question = await instance.question(args.feature, args.text);
			return text(`question ${question.id} created`);
		}
		case 'collab_answer': {
			const question = await instance.answer(args.question, args.text);
			return text(`question ${question.id} answered`);
		}
		case 'collab_handoff': {
			await instance.handoff(args.feature, args.note);
			return text(`handoff recorded for ${args.feature}`);
		}
		case 'collab_project_create': {
			const project = await instance.createProject({
				id: args.id,
				name: args.name,
				repos: args.repos ?? [],
				description: args.description ?? '',
			});
			return text(`created project ${project.id} · ${project.name}`);
		}
		case 'collab_feature_create': {
			const feature = await instance.createFeature({
				projectId: args.project,
				id: args.id,
				title: args.title,
				repos: args.repos,
				brief: args.brief ?? '',
			});
			return text(`created feature ${feature.id} · ${feature.title}`);
		}
		case 'collab_project_archive': {
			const project = await instance.archiveProject(args.id, args.archived !== false);
			return text(`${project.archived ? 'archived' : 'restored'} project ${project.id}`);
		}
		case 'collab_feature_archive': {
			const feature = await instance.archiveFeature(args.id, args.archived !== false);
			return text(`${feature.archived ? 'archived' : 'restored'} feature ${feature.id}`);
		}
		default:
			return text(`unknown tool: ${name}`, true);
	}
}

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(message) {
	if (!message || typeof message !== 'object') return;
	if (message.id === undefined) return; // notification
	const { id, method, params } = message;
	try {
		if (method === 'initialize') {
			send({
				jsonrpc: '2.0',
				id,
				result: {
					protocolVersion: '2024-11-05',
					capabilities: { tools: {} },
					serverInfo: { name: NAME, version: VERSION },
				},
			});
			return;
		}
		if (method === 'ping') {
			send({ jsonrpc: '2.0', id, result: {} });
			return;
		}
		if (method === 'tools/list') {
			send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
			return;
		}
		if (method === 'tools/call') {
			const name = params?.name;
			const args = params?.arguments ?? {};
			try {
				const result = await callTool(name, args);
				send({ jsonrpc: '2.0', id, result });
			} catch (error) {
				send({ jsonrpc: '2.0', id, result: text(error.message ?? String(error), true) });
			}
			return;
		}
		send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
	} catch (error) {
		send({ jsonrpc: '2.0', id, error: { code: -32603, message: error.message ?? String(error) } });
	}
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
	const trimmed = line.trim();
	if (!trimmed) return;
	let message;
	try {
		message = JSON.parse(trimmed);
	} catch (error) {
		process.stderr.write(`collab-mcp: invalid JSON: ${error.message}\n`);
		return;
	}
	void handle(message);
});
