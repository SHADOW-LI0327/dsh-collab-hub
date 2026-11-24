/** Compact human/agent-readable projections of Hub payloads. */

function ago(value) {
	if (!value) return '?';
	const delta = Date.now() - Date.parse(value);
	if (!Number.isFinite(delta) || delta < 0) return value;
	const minutes = Math.floor(delta / 60_000);
	if (minutes < 1) return 'now';
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

function clip(value, max = 160) {
	const text = String(value ?? '').replace(/\s+/g, ' ').trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function formatContext(ctx) {
	const lines = [];
	const project = ctx.project ? `${ctx.project.id} · ${ctx.project.name}` : '?';
	lines.push(`Project: ${project}`);
	lines.push(`Feature: ${ctx.feature.id} · ${ctx.feature.title}`);
	if (ctx.feature.repos?.length) lines.push(`Repos: ${ctx.feature.repos.join(', ')}`);
	if (ctx.feature.brief) lines.push(`Brief: ${clip(ctx.feature.brief, 400)}`);
	lines.push('', 'Members:');
	if (!ctx.statuses?.length) lines.push('- no status yet');
	for (const status of ctx.statuses ?? []) {
		const stale = status.stale ? ' [stale]' : '';
		const blocker = status.blocker ? ` · blocked: ${clip(status.blocker)}` : '';
		lines.push(
			`- ${status.member}${status.role ? ` (${status.role})` : ''}: ${status.state}${status.focus ? ` · ${clip(status.focus)}` : ''}${blocker}${stale} (${ago(status.updatedAt)})`,
		);
	}
	const open = (ctx.questions ?? []).filter((question) => question.status === 'open');
	lines.push('', 'Open questions:');
	if (!open.length) lines.push('- none');
	for (const question of open) {
		lines.push(`- [${question.id}] ${question.author}: ${clip(question.text, 300)} (${ago(question.createdAt)})`);
	}
	const answered = (ctx.questions ?? []).filter((question) => question.status === 'answered').slice(0, 5);
	if (answered.length) {
		lines.push('', 'Recently answered:');
		for (const question of answered) {
			lines.push(`- [${question.id}] ${clip(question.text, 160)} → ${clip(question.answer, 200)} (${question.answeredByName ?? '?'})`);
		}
	}
	lines.push('', 'Artifacts:');
	if (!ctx.artifacts?.length) lines.push('- none');
	for (const artifact of (ctx.artifacts ?? []).slice(0, 12)) {
		lines.push(
			`- [${artifact.kind}] ${artifact.filename} v${artifact.version} · ${artifact.author} — ${clip(artifact.summary, 220)} (${artifact.id})`,
		);
	}
	if (ctx.events?.length) {
		lines.push('', 'Recent changes:');
		for (const event of ctx.events.slice(-12)) {
			const payload = event.payload?.summary ?? event.payload?.text ?? event.payload?.note ?? event.payload?.state ?? '';
			lines.push(`- #${event.id} ${event.type} · ${event.actorId}${payload ? ` · ${clip(payload, 180)}` : ''} (${ago(event.createdAt)})`);
		}
	}
	lines.push('', `Cursor: ${ctx.cursor}`);
	return lines.join('\n');
}

export function formatBoard(board) {
	const lines = ['Team board:'];
	for (const project of board.projects ?? []) {
		lines.push(`\n## ${project.id} · ${project.name}${project.owner ? ` (owner ${project.owner})` : ''}`);
		if (project.repos?.length) lines.push(`repos: ${project.repos.join(', ')}`);
		if (!project.features?.length) {
			lines.push('- no features yet');
			continue;
		}
		for (const feature of project.features) {
			lines.push(`- ${feature.id} · ${feature.title} · ${feature.statuses?.length ?? 0} status / ${feature.artifactCount ?? 0} artifacts / ${feature.openQuestions ?? 0} open questions`);
			for (const status of feature.statuses ?? []) {
				lines.push(`  - ${status.member}: ${status.state}${status.focus ? ` · ${clip(status.focus)}` : ''}${status.blocker ? ` · blocked: ${clip(status.blocker)}` : ''}`);
			}
		}
	}
	return lines.join('\n');
}

export function formatDelta(delta) {
	if (!delta.events?.length) return `No changes since cursor ${delta.cursor}.`;
	const lines = [`Changes up to cursor ${delta.cursor}:`];
	for (const event of delta.events) {
		const payload = event.payload?.summary ?? event.payload?.text ?? event.payload?.note ?? event.payload?.state ?? '';
		lines.push(`- #${event.id} ${event.type}${payload ? ` · ${clip(payload, 220)}` : ''} (${ago(event.createdAt)})`);
	}
	return lines.join('\n');
}
