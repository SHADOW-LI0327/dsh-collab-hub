#!/usr/bin/env node
/**
 * collab — CLI for the intranet collaboration hub.
 *
 * `collab hub` starts the service; every other command talks to it with the
 * member token saved in ~/.dsh/collab.json.
 */
import { readFile, stat } from 'node:fs/promises';
import { createHub } from '../lib/server.mjs';
import { Store } from '../lib/store.mjs';
import { HubClient, configPath, loadConfig, saveConfig } from '../lib/client.mjs';
import { formatBoard, formatContext, formatDelta } from '../lib/format.mjs';

const HELP = `collab — team collaboration hub

Usage:
  collab hub [--port 8787] [--host 127.0.0.1] [--data ./data]
  collab register --name A [--role frontend] [--hub URL]
  collab whoami
  collab token
  collab member reset --name A [--data ./data]
  collab board [--include-archived] [--json]

  collab project create <id> --name <name> [--repos web,api] [--description ...]
  collab project list [--include-archived]
  collab project archive <id> [--restore]
  collab feature create <project> <id> --title <title> [--repos web,api] [--brief ...]
  collab feature list [project] [--include-archived]
  collab feature archive <id> [--restore]

  collab context <feature> [--since N] [--json]
  collab delta <feature> [--since N] [--json]
  collab status <feature> --state <state> [--focus ...] [--blocker ...]
  collab publish <feature> <file> [--kind design|report|contract|note|other] [--summary ...]
  collab question <feature> <text>
  collab answer <question-id> <text>
  collab handoff <feature> <note>

States: idle, designing, implementing, reviewing, blocked, done
`;

function parse(args) {
	const positionals = [];
	const flags = {};
	for (let i = 0; i < args.length; i += 1) {
		const token = args[i];
		if (!token.startsWith('--')) {
			positionals.push(token);
			continue;
		}
		const body = token.slice(2);
		const eq = body.indexOf('=');
		if (eq >= 0) {
			flags[body.slice(0, eq)] = body.slice(eq + 1);
			continue;
		}
		const next = args[i + 1];
		if (next !== undefined && !next.startsWith('--')) {
			flags[body] = next;
			i += 1;
		} else {
			flags[body] = true;
		}
	}
	return { positionals, flags };
}

function die(message) {
	console.error(`collab: ${message}`);
	process.exitCode = 1;
}

async function client(overrides = {}) {
	const config = await loadConfig();
	const instance = new HubClient({ ...config, ...overrides });
	if (!instance.token) throw new Error(`not registered; run: collab register --name <you> --hub ${instance.hubUrl}`);
	return instance;
}

async function startHub(flags) {
	const dataDir = String(flags.data ?? './data');
	const host = String(flags.host ?? '127.0.0.1');
	const port = Number(flags.port ?? 8787);
	const hub = await createHub({ dataDir, host, port });
	const address = await hub.start();
	const actualPort = typeof address === 'object' && address ? address.port : port;
	console.log(`Collab Hub listening on http://${host}:${actualPort} (data: ${dataDir})`);
	const stop = async () => {
		await hub.close();
		process.exit(0);
	};
	process.once('SIGINT', stop);
	process.once('SIGTERM', stop);
}

async function main() {
	const [command, ...rest] = process.argv.slice(2);
	if (!command || command === 'help' || command === '--help' || command === '-h') {
		console.log(HELP);
		return;
	}
	const { positionals, flags } = parse(rest);

	if (command === 'hub' || command === 'serve') {
		await startHub(flags);
		return;
	}

	if (command === 'register') {
		const name = flags.name ?? positionals[0];
		if (!name) return die('register needs --name');
		const config = await loadConfig();
		const hubUrl = String(flags.hub ?? config.hubUrl);
		const instance = new HubClient({ hubUrl });
		const result = await instance.register(String(name), flags.role ? String(flags.role) : undefined);
		await saveConfig({
			hubUrl,
			name: result.member.name,
			role: result.member.role,
			token: result.token,
		});
		console.log(`registered ${result.member.name} (${result.member.role}); token saved to ${configPath()}`);
		return;
	}

	if (command === 'member') {
		const sub = positionals.shift();
		if (sub === 'reset') {
			const name = flags.name ?? positionals[0];
			if (!name) return die('member reset needs --name');
			const dataDir = String(flags.data ?? './data');
			const store = await new Store(dataDir).init();
			const result = await store.resetToken(String(name));
			console.log(`new token for ${result.member.name}: ${result.token}`);
			console.log('store it in ~/.dsh/collab.json (or rerun register on that machine)');
			return;
		}
		return die('member commands: reset');
	}

	if (command === 'token') {
		const config = await loadConfig();
		if (!config.token) return die('not registered; run collab register first');
		console.log(config.token);
		return;
	}

	if (command === 'whoami') {
		const instance = await client();
		const result = await instance.me();
		console.log(`${result.member.name} (${result.member.role}) @ ${instance.hubUrl}`);
		return;
	}

	if (command === 'config') {
		const config = await loadConfig();
		console.log(`hub:  ${config.hubUrl}`);
		console.log(`name: ${config.name || '(not registered)'}`);
		console.log(`role: ${config.role || '-'}`);
		console.log(`token: ${config.token ? `${config.token.slice(0, 8)}…` : '(none)'}`);
		console.log(`file: ${configPath()}`);
		return;
	}

	if (command === 'board') {
		const instance = await client();
		const board = await instance.board(Boolean(flags['include-archived']));
		if (flags.json) console.log(JSON.stringify(board, null, 2));
		else console.log(formatBoard(board));
		return;
	}

	if (command === 'project') {
		const sub = positionals.shift();
		const instance = await client();
		if (sub === 'list') {
			const { projects } = await instance.projects(Boolean(flags['include-archived']));
			for (const project of projects) {
				console.log(`${project.id} · ${project.name} · ${project.featureCount} feature(s) · ${project.owner ?? '?'}${project.archived ? ' · ARCHIVED' : ''}`);
			}
			return;
		}
		if (sub === 'archive') {
			const id = positionals.shift();
			if (!id) return die('project archive needs an id');
			const project = await instance.archiveProject(id, !flags.restore);
			console.log(`${project.archived ? 'archived' : 'restored'} project ${project.id}`);
			return;
		}
		if (sub === 'create') {
			const id = positionals.shift();
			if (!id) return die('project create needs an id');
			const project = await instance.createProject({
				id,
				name: flags.name ?? id,
				description: flags.description ?? '',
				repos: flags.repos ? String(flags.repos).split(',').map((value) => value.trim()).filter(Boolean) : [],
			});
			console.log(`created project ${project.id} · ${project.name}`);
			return;
		}
		return die('project commands: create | list | archive');
	}

	if (command === 'feature') {
		const sub = positionals.shift();
		const instance = await client();
		if (sub === 'list') {
			const { features } = await instance.features(positionals[0], Boolean(flags['include-archived']));
			for (const feature of features) {
				console.log(`${feature.id} · ${feature.title} · ${feature.projectId} · ${feature.artifactCount} artifact(s) · ${feature.openQuestions} open question(s)${feature.archived ? ' · ARCHIVED' : ''}`);
			}
			return;
		}
		if (sub === 'archive') {
			const id = positionals.shift();
			if (!id) return die('feature archive needs an id');
			const feature = await instance.archiveFeature(id, !flags.restore);
			console.log(`${feature.archived ? 'archived' : 'restored'} feature ${feature.id}`);
			return;
		}
		if (sub === 'create') {
			const project = positionals.shift();
			const id = positionals.shift();
			if (!project || !id) return die('feature create needs <project> <id>');
			const feature = await instance.createFeature({
				projectId: project,
				id,
				title: flags.title ?? id,
				repos: flags.repos ? String(flags.repos).split(',').map((value) => value.trim()).filter(Boolean) : undefined,
				brief: flags.brief ?? '',
			});
			console.log(`created feature ${feature.id} · ${feature.title} (${feature.projectId})`);
			return;
		}
		return die('feature commands: create | list | archive');
	}

	if (command === 'context') {
		const feature = positionals[0];
		if (!feature) return die('context needs a feature id');
		const instance = await client();
		const ctx = await instance.context(feature, flags.since ? Number(flags.since) : 0);
		if (flags.json) console.log(JSON.stringify(ctx, null, 2));
		else console.log(formatContext(ctx));
		return;
	}

	if (command === 'delta') {
		const feature = positionals[0];
		if (!feature) return die('delta needs a feature id');
		const instance = await client();
		const delta = await instance.delta(feature, flags.since ? Number(flags.since) : 0);
		if (flags.json) console.log(JSON.stringify(delta, null, 2));
		else console.log(formatDelta(delta));
		return;
	}

	if (command === 'status') {
		const feature = positionals[0];
		if (!feature) return die('status needs a feature id');
		if (!flags.state) return die('status needs --state');
		const instance = await client();
		const status = await instance.status(feature, {
			state: String(flags.state),
			focus: flags.focus ? String(flags.focus) : '',
			blocker: flags.blocker ? String(flags.blocker) : '',
		});
		console.log(`${status.member}: ${status.state}${status.focus ? ` · ${status.focus}` : ''}`);
		return;
	}

	if (command === 'publish') {
		const feature = positionals.shift();
		const file = positionals.shift();
		if (!feature || !file) return die('publish needs <feature> <file>');
		const info = await stat(file).catch(() => null);
		if (!info?.isFile()) return die(`not a file: ${file}`);
		const instance = await client();
		const artifact = await instance.publish(feature, file, {
			kind: flags.kind ? String(flags.kind) : 'design',
			summary: flags.summary ? String(flags.summary) : '',
		});
		console.log(`published ${artifact.filename} v${artifact.version} (${artifact.kind}) as ${artifact.id}`);
		console.log(instance.absoluteUrl(artifact.url));
		return;
	}

	if (command === 'question') {
		const feature = positionals.shift();
		const text = positionals.join(' ').trim() || flags.text;
		if (!feature || !text) return die('question needs <feature> <text>');
		const instance = await client();
		const question = await instance.question(feature, String(text));
		console.log(`question ${question.id} created for ${feature}`);
		return;
	}

	if (command === 'answer') {
		const id = positionals.shift();
		const text = positionals.join(' ').trim() || flags.text;
		if (!id || !text) return die('answer needs <question-id> <text>');
		const instance = await client();
		const question = await instance.answer(id, String(text));
		console.log(`answered ${question.id}`);
		return;
	}

	if (command === 'handoff') {
		const feature = positionals.shift();
		const note = positionals.join(' ').trim() || flags.note;
		if (!feature || !note) return die('handoff needs <feature> <note>');
		const instance = await client();
		await instance.handoff(feature, String(note));
		console.log(`handoff recorded for ${feature}`);
		return;
	}

	return die(`unknown command: ${command}`);
}

main().catch((error) => die(error.message ?? String(error)));
