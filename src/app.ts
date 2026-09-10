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
import { generateTriggersForEffect } from "./actions/triggers.ts";
import applyDefaultInterceptors from "./default_interceptors/index.ts";
import ProxyStore, { makeId } from "./proxy-store.ts";
import {
	type ActionRecord,
	actionIdParamSchema,
	actionRequestSchema,
	connectionIdsQuerySchema,
	type ExtendedProxyConfig,
	encodingSchema,
	getConfig,
	interceptorSchema,
	type ListActionTriggersResponse,
	paramSchema,
	parseBuffer,
	proxyConfigSchema,
	slotMigrateEffectSchema,
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
		actionRecord.status = "running";
		executeAction(type, parameters, proxyStore, config)
			.then((result) => {
				actionRecord.status = result.status;
				actionRecord.output = result.output ?? "Done";
				actionRecord.error = result.error ?? null;
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

	// GET /action - List all submitted actions
	app.get("/action", (c) => {
		const actions = Array.from(actionStore.values()).map((action) => ({
			job_id: action.id,
			action_type: action.type,
			status: action.status,
			submitted_at: action.submittedAt.toISOString(),
		}));
		return c.json({ actions });
	});

	// GET /slot-migrate - List action triggers for an effect
	app.get("/slot-migrate", zValidator("query", slotMigrateEffectSchema), (c) => {
		const { effect } = c.req.valid("query");

		const response: ListActionTriggersResponse = {
			effect,
			cluster: { index: 0, nodes: proxyStore.nodeIds.length },
			triggers: generateTriggersForEffect(effect, proxyStore.nodeIds.length),
		};

		return c.json(response);
	});

	return { app, proxy: proxyStore.proxies[0] as RedisProxy, config };
}
