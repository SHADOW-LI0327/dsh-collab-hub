/**
 * Public API catalog for dsh-collab-hub.
 *
 * The Hub is a separate project from dsh-process-kit; this catalog is the
 * single place that lists its HTTP surface, so the plugin can link here
 * instead of carrying a duplicate API reference.
 */

const ENDPOINTS = [
	{ method: 'GET', path: '/api', auth: 'public', summary: 'This API catalog (JSON)', response: 'endpoints, auth, OpenAPI link' },
	{ method: 'GET', path: '/api/openapi.json', auth: 'public', summary: 'OpenAPI 3.1 document', response: 'OpenAPI JSON' },
	{ method: 'GET', path: '/api/health', auth: 'public', summary: 'Service health', response: '{ ok, service }' },
	{ method: 'POST', path: '/api/register', auth: 'public', summary: 'Register a member (no admin approval)', body: 'name, role?', response: 'member, token' },
	{ method: 'GET', path: '/api/me', auth: 'bearer', summary: 'Current member', response: 'member' },
	{ method: 'GET', path: '/api/board', auth: 'bearer', summary: 'Projects, features, member states and counts', query: ['includeArchived=1'], response: 'board' },
	{ method: 'GET', path: '/api/projects', auth: 'bearer', summary: 'List projects', query: ['includeArchived=1'], response: 'projects[]' },
	{ method: 'POST', path: '/api/projects', auth: 'bearer', summary: 'Create a project', body: 'id, name, description?, repos?', response: 'project' },
	{ method: 'GET', path: '/api/projects/{id}', auth: 'bearer', summary: 'Read one project', response: 'project' },
	{ method: 'POST', path: '/api/projects/{id}/archive', auth: 'bearer', summary: 'Archive or restore a project', body: 'archived?: boolean', response: 'project' },
	{ method: 'POST', path: '/api/projects/{id}/features', auth: 'bearer', summary: 'Create a feature under a project', body: 'id, title, repos?, brief?', response: 'feature' },
	{ method: 'GET', path: '/api/features', auth: 'bearer', summary: 'List features', query: ['project=<id>', 'includeArchived=1'], response: 'features[]' },
	{ method: 'POST', path: '/api/features', auth: 'bearer', summary: 'Create a feature (projectId in body)', body: 'projectId, id, title, repos?, brief?', response: 'feature' },
	{ method: 'GET', path: '/api/features/{id}/context', auth: 'bearer', summary: 'Shared feature context: statuses, questions, artifacts, events', query: ['since=<cursor>'], response: 'context' },
	{ method: 'GET', path: '/api/features/{id}/delta', auth: 'bearer', summary: 'Changes after a cursor', query: ['since=<cursor>'], response: 'events[], cursor' },
	{ method: 'POST', path: '/api/features/{id}/status', auth: 'bearer', summary: 'Update a member status', body: 'state, focus?, blocker?', response: 'status' },
	{ method: 'POST', path: '/api/features/{id}/artifacts', auth: 'bearer', summary: 'Publish an artifact (multipart file or raw body)', body: 'file/body, kind, summary, filename', response: 'artifact + signed url' },
	{ method: 'POST', path: '/api/features/{id}/questions', auth: 'bearer', summary: 'Ask a question', body: 'text', response: 'question' },
	{ method: 'POST', path: '/api/features/{id}/archive', auth: 'bearer', summary: 'Archive or restore a feature', body: 'archived?: boolean', response: 'feature' },
	{ method: 'POST', path: '/api/features/{id}/handoff', auth: 'bearer', summary: 'Record a handoff note', body: 'note', response: 'featureId, note' },
	{ method: 'POST', path: '/api/questions/{id}/answer', auth: 'bearer', summary: 'Answer an open question', body: 'text', response: 'question' },
	{ method: 'GET', path: '/api/artifacts/{id}', auth: 'bearer', summary: 'Artifact metadata + signed URL', response: 'artifact' },
	{ method: 'GET', path: '/api/artifacts/{id}/url', auth: 'bearer', summary: 'Issue a short-lived signed URL', response: '{ url, expiresAt }' },
	{ method: 'GET', path: '/api/artifacts/{id}/raw', auth: 'signed', summary: 'Read artifact bytes with exp + sig', query: ['exp=<ms>', 'sig=<hmac>'], response: 'file bytes' },
];

const MCP_TOOLS = [
	'collab_register',
	'collab_context',
	'collab_delta',
	'collab_publish',
	'collab_status',
	'collab_question',
	'collab_answer',
	'collab_handoff',
	'collab_project_create',
	'collab_feature_create',
	'collab_project_archive',
	'collab_feature_archive',
];

export function apiCatalog(version) {
	return {
		service: 'dsh-collab-hub',
		version,
		auth: {
			type: 'bearer',
			header: 'Authorization: Bearer <member token>',
			register: 'POST /api/register',
			signedReads: 'GET /api/artifacts/{id}/raw uses short-lived exp + sig',
		},
		openapi: '/api/openapi.json',
		mcp: { transport: 'stdio', entry: 'mcp/server.mjs', tools: MCP_TOOLS },
		endpoints: ENDPOINTS,
	};
}

export function openApiSpec(version) {
	const paths = {};
	const tags = new Set();
	for (const endpoint of ENDPOINTS) {
		const tag = endpoint.path.split('/')[2] ?? 'root';
		tags.add(tag);
		const path = endpoint.path.replace(/:([A-Za-z]+)/g, '{$1}');
		const pathParams = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
		const operation = {
			tags: [tag],
			summary: endpoint.summary,
			operationId: `${endpoint.method.toLowerCase()}_${path.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
			responses: {
				'200': { description: endpoint.response ?? 'OK' },
				'400': { description: 'Bad request' },
				'401': { description: 'Missing or invalid member token' },
				'404': { description: 'Not found' },
				'409': { description: 'Conflict (duplicate, archived, already answered)' },
			},
			security: endpoint.auth === 'bearer' ? [{ bearerAuth: [] }] : [],
		};
		if (endpoint.auth === 'signed') operation.description = 'Requires the short-lived `exp` + `sig` query pair.';
		if (pathParams.length) {
			operation.parameters = pathParams.map((name) => ({
				name,
				in: 'path',
				required: true,
				schema: { type: 'string' },
			}));
		}
		if (endpoint.query) {
			operation.parameters = [
				...(operation.parameters ?? []),
				...endpoint.query.map((entry) => {
					const [name, description] = entry.split('=');
					return { name, in: 'query', required: false, description, schema: { type: 'string' } };
				}),
			];
		}
		if (endpoint.body) {
			operation.requestBody = {
				required: true,
				content: {
					'application/json': {
						schema: { type: 'object', description: endpoint.body, additionalProperties: true },
					},
					'multipart/form-data': {
						schema: { type: 'object', description: endpoint.body, additionalProperties: true },
					},
				},
			};
		}
		paths[path] = { ...(paths[path] ?? {}), [endpoint.method.toLowerCase()]: operation };
	}
	return {
		openapi: '3.1.0',
		info: {
			title: 'dsh-collab-hub',
			version,
			description: 'Intranet collaboration hub for DSH process teams: projects, features, member status, artifacts and questions.',
		},
		servers: [{ url: '/' }],
		tags: [...tags].map((name) => ({ name })),
		paths,
		components: {
			securitySchemes: {
				bearerAuth: { type: 'http', scheme: 'bearer', description: 'Member token from POST /api/register' },
			},
		},
	};
}
