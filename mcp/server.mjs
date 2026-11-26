#!/usr/bin/env node
/**
 * collab-mcp — stdio MCP server for non-DSH agents.
 * The same tool catalog is served over the Hub's Streamable HTTP /mcp endpoint.
 */
import { createInterface } from 'node:readline';
import { MCP_NAME, MCP_VERSION, TOOLS, callTool } from '../lib/mcp-tools.mjs';

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(message) {
	if (!message || typeof message !== 'object') return;
	if (message.id === undefined) return;
	const { id, method, params } = message;
	try {
		if (method === 'initialize') {
			send({
				jsonrpc: '2.0',
				id,
				result: {
					protocolVersion: '2025-06-18',
					capabilities: { tools: {} },
					serverInfo: { name: MCP_NAME, version: MCP_VERSION },
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
			try {
				send({ jsonrpc: '2.0', id, result: await callTool(params?.name, params?.arguments ?? {}) });
			} catch (error) {
				send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: error.message ?? String(error) }], isError: true } });
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
