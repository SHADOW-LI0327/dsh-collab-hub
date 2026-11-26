/**
 * Minimal MCP Streamable HTTP transport at POST /mcp.
 *
 * The official SDK accepts a plain JSON-RPC JSON response for each POST; this
 * service is stateless and does not need an SSE stream for normal request /
 * response calls. Each request is authenticated with the member token and
 * reuses the same tool catalog as the stdio MCP server.
 */
import { HubClient } from './client.mjs';
import { MCP_NAME, MCP_VERSION, TOOLS, callTool } from './mcp-tools.mjs';

const MAX_JSON = 1024 * 1024;

async function readJson(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_JSON) {
			const error = new Error('request too large');
			error.status = 413;
			throw error;
		}
		chunks.push(chunk);
	}
	if (chunks.length === 0) return {};
	return JSON.parse(Buffer.concat(chunks).toString('utf8'));
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

function textResult(value, isError = false) {
	return { content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) };
}

async function handleMessage(message, client, member) {
	if (!message || typeof message !== 'object') return null;
	const { id, method, params } = message;
	if (id === undefined) return null;
	if (method === 'initialize') {
		return {
			jsonrpc: '2.0',
			id,
			result: {
				protocolVersion: '2025-06-18',
				capabilities: { tools: {} },
				serverInfo: { name: MCP_NAME, version: MCP_VERSION },
			},
		};
	}
	if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
	if (method === 'tools/list') {
		return {
			jsonrpc: '2.0',
			id,
			result: { tools: TOOLS.filter((tool) => tool.name !== 'collab_register') },
		};
	}
	if (method === 'tools/call') {
		try {
			return { jsonrpc: '2.0', id, result: await callTool(params?.name, params?.arguments ?? {}, { client }) };
		} catch (error) {
			return { jsonrpc: '2.0', id, result: textResult(error.message ?? String(error), true) };
		}
	}
	return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
}

export async function handleMcpHttp(req, res, { store } = {}) {
	const authorization = req.headers.authorization ?? '';
	const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
	const member = store?.memberByToken(token);
	if (!member) {
		sendJson(res, { jsonrpc: '2.0', error: { code: -32001, message: 'missing or invalid member token' } }, 401);
		return;
	}
	if (req.method === 'GET') {
		// The client does not need the optional server-initiated SSE channel for
		// tools/list + tools/call; advertise that this endpoint is POST-only.
		res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' });
		res.end(JSON.stringify({ error: 'use POST /mcp' }));
		return;
	}
	if (req.method === 'DELETE') {
		res.writeHead(204);
		res.end();
		return;
	}
	let body;
	try {
		body = await readJson(req);
	} catch (error) {
		sendJson(res, { jsonrpc: '2.0', error: { code: -32700, message: error.message } }, error.status ?? 400);
		return;
	}
	const port = req.socket.localPort;
	const client = new HubClient({ hubUrl: `http://127.0.0.1:${port}`, token });
	const messages = Array.isArray(body) ? body : [body];
	const responses = [];
	for (const message of messages) {
		const response = await handleMessage(message, client, member);
		if (response) responses.push(response);
	}
	if (responses.length === 0) {
		res.writeHead(202, { 'content-type': 'application/json' });
		res.end();
		return;
	}
	sendJson(res, Array.isArray(body) ? responses : responses[0]);
}
