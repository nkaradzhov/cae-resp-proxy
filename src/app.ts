import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { logger } from "hono/logger";
import {
	type InterceptorDescription,
	type InterceptorState,
	type Next,
	type ProxyConfig,
	type ProxyStats,
	RedisProxy,
	type SendResult,
} from "redis-monorepo/packages/test-utils/lib/proxy/redis-proxy.ts";
import { executeAction } from "./actions/index.ts";
import applyDefaultInterceptors from "./default_interceptors/index.ts";
import ProxyStore, { makeId } from "./proxy-store.ts";
import {
	type ActionRecord,
	type ActionTrigger,
	type ListActionTriggersResponse,
	actionIdParamSchema,
	actionRequestSchema,
	connectionIdsQuerySchema,
	type ExtendedProxyConfig,
	encodingSchema,
	getConfig,
	interceptorSchema,
	paramSchema,
	parseBuffer,
	proxyConfigSchema,
	slotMigrateEffectSchema,
	type SlotMigrateEffect,
} from "./util.ts";

const startNewProxy = (config: ProxyConfig) => {
	const proxy = new RedisProxy(config);
	proxy.start().catch(console.error);
	return proxy;
};

export function createApp(testConfig?: ExtendedProxyConfig) {
	const config = testConfig || getConfig();
	const app = new Hono();
	app.use(logger());

	const proxyStore = new ProxyStore();

	for (const port of config.listenPort) {
		const proxyConfig: ProxyConfig = { ...config, listenPort: port };
		const nodeId = makeId(config.targetHost, config.targetPort, port);
		proxyStore.add(nodeId, startNewProxy(proxyConfig));
	}

	config.defaultInterceptors && applyDefaultInterceptors(config.defaultInterceptors, proxyStore);

	app.post("/nodes", zValidator("json", proxyConfigSchema), async (c) => {
		const data = await c.req.json();
		const cfg: ProxyConfig = { ...config, ...data };
		const nodeId = makeId(cfg.targetHost, cfg.targetPort, cfg.listenPort);
		proxyStore.add(nodeId, startNewProxy(cfg));
		config.defaultInterceptors && applyDefaultInterceptors(config.defaultInterceptors, proxyStore);
		return c.json({ success: true, cfg });
	});

	app.delete("/nodes/:id", async (c) => {
		const nodeId = c.req.param("id");
		const success = await proxyStore.delete(nodeId);
		return c.json({ success });
	});

	app.get("/nodes", (c) => {
		return c.json({ ids: proxyStore.nodeIds });
	});

	app.get("/stats", (c) => {
		const response = proxyStore.entries.reduce(
			(acc, [id, proxy]) => {
				acc[id] = proxy.getStats();
				return acc;
			},
			{} as Record<string, ProxyStats>,
		);
		return c.json(response);
	});

	app.get("/connections", (c) => {
		const response = proxyStore.entries.reduce(
			(acc, [id, proxy]) => {
				acc[id] = proxy.getActiveConnectionIds();
				return acc;
			},
			{} as Record<string, readonly string[]>,
		);
		return c.json(response);
	});

	app.post(
		"/send-to-client/:connectionId",
		zValidator("param", paramSchema),
		zValidator("query", encodingSchema),
		async (c) => {
			const { connectionId } = c.req.valid("param");
			const { encoding } = c.req.valid("query");
			const data = await c.req.text();

			const buffer = parseBuffer(data, encoding);

			const proxy = proxyStore.getProxyByConnectionId(connectionId);
			if (!proxy)
				return c.json({
					success: false,
					error: "Connection not found",
					connectionId,
				});

			const result = proxy.sendToClient(connectionId, buffer);
			return c.json(result);
		},
	);

	app.post("/send-to-clients", zValidator("query", connectionIdsQuerySchema), async (c) => {
		const { connectionIds, encoding } = c.req.valid("query");
		const data = await c.req.text();

		const buffer = parseBuffer(data, encoding);

		const results: SendResult[] = [];
		for (const [proxy, matchingConIds] of proxyStore.getProxiesByConnectionIds(connectionIds)) {
			results.push(...proxy.sendToClients(matchingConIds, buffer));
		}
		return c.json({ results });
	});

	app.post("/send-to-all-clients", zValidator("query", encodingSchema), async (c) => {
		const { encoding } = c.req.valid("query");
		const data = await c.req.text();
		const buffer = parseBuffer(data, encoding);
		const results: SendResult[] = [];
		for (const proxy of proxyStore.proxies) {
			results.push(...proxy.sendToAllClients(buffer));
		}
		return c.json({ results });
	});

	app.delete("/connections/:id", (c) => {
		const connectionId = c.req.param("id");
		const proxy = proxyStore.getProxyByConnectionId(connectionId);
		if (!proxy)
			return c.json({
				success: false,
				connectionId,
			});
		const success = proxy.closeConnection(connectionId);
		return c.json({ success, connectionId });
	});

	app.post("/interceptors", zValidator("json", interceptorSchema), async (c) => {
		const { name, match, response, encoding } = c.req.valid("json");

		const responseBuffer = parseBuffer(response, encoding);
		const matchBuffer = parseBuffer(match, encoding);

		const interceptor: InterceptorDescription = {
			name,
			fn: async (data: Buffer, next: Next, state: InterceptorState): Promise<Buffer> => {
				state.invokeCount++;
				if (data.toString().toLowerCase() === matchBuffer.toString().toLowerCase()) {
					state.matchCount++;
					return responseBuffer;
				}
				return next(data);
			},
		};

		for (const proxy of proxyStore.proxies) {
			proxy.addGlobalInterceptor(interceptor);
		}

		return c.json({ success: true, name });
	});

	// In-memory action storage
	const actionStore = new Map<string, ActionRecord>();

	// Generate unique action ID
	const generateActionId = (): string => {
		return `action-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
	};

	// POST /action - Submit an action
	app.post("/action", zValidator("json", actionRequestSchema), async (c) => {
		const { type, parameters } = c.req.valid("json");

		const actionId = generateActionId();
		const actionRecord: ActionRecord = {
			id: actionId,
			type,
			parameters,
			status: "pending",
			submittedAt: new Date(),
			error: null,
			output: null,
		};

		actionStore.set(actionId, actionRecord);

		// Execute the action asynchronously
		executeAction(type, parameters, proxyStore, config)
			.then((result) => {
				actionRecord.status = result.status;
				actionRecord.output = "Done";
				actionRecord.error = result.error;
			})
			.catch((error) => {
				actionRecord.status = "failed";
				actionRecord.error = error instanceof Error ? error.message : String(error);
			});

		return c.json({ action_id: actionId });
	});

	// GET /action/:action_id - Get action status
	app.get("/action/:action_id", zValidator("param", actionIdParamSchema), (c) => {
		const { action_id } = c.req.valid("param");

		const action = actionStore.get(action_id);
		if (!action) {
			return c.json({ error: "Action not found" }, 404);
		}

		return c.json({
			status: action.status,
			error: action.error,
			output: action.output,
		});
	});

	// Hardcoded triggers for each effect
	const triggersMap: Record<SlotMigrateEffect, ActionTrigger[]> = {
		add: [
			{
				name: "add-node-trigger-1",
				description: "Trigger when a new node is added to the cluster",
				requirements: [
					{ dbconfig: {}, cluster: { minNodes: 3 }, description: "Requires at least 3 shards and 3 nodes" },
				],
			},
			{
				name: "add-node-trigger-2",
				description: "Trigger for rebalancing after node addition",
				requirements: [
					{ dbconfig: {}, cluster: { healthy: true }, description: "Requires replication enabled and healthy cluster" },
				],
			},
		],
		remove: [
			{
				name: "remove-node-trigger-1",
				description: "Trigger when a node is removed from the cluster",
				requirements: [
					{ dbconfig: {}, cluster: { minNodes: 2 }, description: "Requires at least 2 shards and 2 nodes" },
				],
			},
			{
				name: "remove-node-trigger-2",
				description: "Trigger for slot migration before node removal",
				requirements: [
					{ dbconfig: {}, cluster: { noFailover: true }, description: "Requires persistence and no ongoing failover" },
				],
			},
		],
		"remove-add": [
			{
				name: "remove-add-trigger-1",
				description: "Trigger for combined remove and add operation",
				requirements: [
					{ dbconfig: {}, cluster: { minNodes: 3 }, description: "Requires at least 3 shards and 3 nodes" },
				],
			},
			{
				name: "remove-add-trigger-2",
				description: "Trigger for atomic node replacement",
				requirements: [
					{ dbconfig: {}, cluster: { quorum: true }, description: "Requires replication and quorum" },
				],
			},
		],
		"slot-shuffle": [
			{
				name: "slot-shuffle-trigger-1",
				description: "Trigger for redistributing slots across nodes",
				requirements: [
					{ dbconfig: {}, cluster: { balanced: false }, description: "Requires at least 2 shards and unbalanced cluster" },
				],
			},
			{
				name: "slot-shuffle-trigger-2",
				description: "Trigger for optimizing slot distribution",
				requirements: [
					{ dbconfig: {}, cluster: { healthy: true }, description: "Requires auto-balance enabled and healthy cluster" },
				],
			},
		],
	};

	// GET /slot-migrate - List action triggers for an effect
	app.get("/slot-migrate", zValidator("query", slotMigrateEffectSchema), (c) => {
		const { effect } = c.req.valid("query");

		const response: ListActionTriggersResponse = {
			effect,
			cluster: { index: 0, nodes: proxyStore.nodeIds.length },
			triggers: triggersMap[effect],
		};

		return c.json(response);
	});

	return { app, proxy: proxyStore.proxies[0] as RedisProxy, config };
}
