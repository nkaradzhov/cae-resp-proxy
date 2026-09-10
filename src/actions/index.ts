import {
	type ProxyConfig,
	RedisProxy,
} from "redis-monorepo/packages/test-utils/lib/proxy/redis-proxy";
import applyDefaultInterceptors from "../default_interceptors/index";
import type ProxyStore from "../proxy-store";
import { makeId } from "../proxy-store";
import {
	addNode,
	buildSMigratedNotification,
	buildSMigratingNotification,
	createCustomClusterSlotsInterceptor,
	findNextAvailablePort,
	getSlotRangesForProxy,
	pickRandom,
	sendToAllClients,
} from "../scenarios/helpers";
import { getNextSequenceId } from "../scenarios/sequence-gen";
import type { ActionType, ExtendedProxyConfig } from "../util";

// Effect types matching Python MigrateEffect enum
export type SlotMigrateEffect = "remove-add" | "remove" | "add" | "slot-shuffle";

export interface SlotMigrateParams {
	effect: SlotMigrateEffect;
	variant?: string;
	source_node?: number;
	target_node?: number;
}

export interface ActionExecutionResult {
	status: "success" | "failed";
	error?: string | null;
	output?: unknown;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The window between SMIGRATING and SMIGRATED, and the settle time before a
// removed node is stopped. Overridable so tests do not wait several seconds.
const migrationDelayMs = () => Number(process.env.MIGRATION_DELAY_MS ?? 5000);
const completionDelayMs = () => Number(process.env.COMPLETION_DELAY_MS ?? 2000);

// How long to wait after a client connects before pushing SMIGRATING to it,
// so the push lands after the client finished its HELLO handshake.
const NEW_CONNECTION_PUSH_DELAY_MS = 25;

/**
 * While a migration is active, push the SMIGRATING notification to every
 * client that connects, matching how a real cluster treats connections
 * opened while a migration is in progress.
 * Returns a function that stops the notifications.
 */
function pushToNewConnections(proxyStore: ProxyStore, buffer: Buffer): () => void {
	const subscriptions = proxyStore.proxies.map((proxy) => {
		const listener = (connection: { id: string }) => {
			setTimeout(() => proxy.sendToClient(connection.id, buffer), NEW_CONNECTION_PUSH_DELAY_MS);
		};
		proxy.on("connection", listener);
		return () => proxy.off("connection", listener);
	});
	return () => {
		for (const unsubscribe of subscriptions) unsubscribe();
	};
}

async function startNode(proxyStore: ProxyStore, config: ProxyConfig): Promise<RedisProxy> {
	const proxy = new RedisProxy(config);
	// Without a listener, the 'error' the proxy emits alongside a failed
	// start() escapes the EventEmitter and crashes the process.
	proxy.on("error", (error: Error) => console.error("[proxy]", error.message));
	await proxy.start();
	proxyStore.add(makeId(config.targetHost, config.targetPort, config.listenPort), proxy);
	return proxy;
}

/** Next free listen port, never colliding with the backend target port. */
function nextListenPort(proxyStore: ProxyStore, config: ExtendedProxyConfig): number {
	let port =
		proxyStore.proxies.length > 0
			? findNextAvailablePort(proxyStore.proxies)
			: Math.max(...config.listenPort);
	while (port === config.targetPort) port++;
	return port;
}

async function removeNode(proxyStore: ProxyStore, proxy: RedisProxy): Promise<void> {
	const { targetHost, targetPort, listenPort } = proxy.config;
	await proxyStore.delete(makeId(targetHost, targetPort, listenPort));
}

function refreshClusterSlots(proxyStore: ProxyStore): void {
	const interceptor = createCustomClusterSlotsInterceptor(proxyStore.proxies);
	for (const proxy of proxyStore.proxies) {
		proxy.addGlobalInterceptor(interceptor);
	}
}

/**
 * Execute an action based on its type and parameters
 */
export async function executeAction(
	actionType: ActionType,
	parameters: Record<string, unknown>,
	proxyStore: ProxyStore,
	config: ExtendedProxyConfig,
): Promise<ActionExecutionResult> {
	switch (actionType) {
		case "slot_migrate":
			return executeSlotMigrate(parameters as unknown as SlotMigrateParams, proxyStore, config);
		case "reset_cluster":
			return executeResetCluster(proxyStore, config);
		case "create_database":
			return executeCreateDatabase(parameters, proxyStore, config);
		default:
			return { status: "success" };
	}
}

/**
 * Restore the initial proxy topology and drop interceptors added by earlier
 * actions. Test harnesses call this before every test.
 */
async function executeResetCluster(
	proxyStore: ProxyStore,
	config: ExtendedProxyConfig,
): Promise<ActionExecutionResult> {
	try {
		for (const id of proxyStore.nodeIds) {
			await proxyStore.delete(id);
		}
		for (const port of config.listenPort) {
			await startNode(proxyStore, { ...config, listenPort: port });
		}
		if (config.defaultInterceptors) {
			applyDefaultInterceptors(config.defaultInterceptors, proxyStore);
		}
		return { status: "success" };
	} catch (error) {
		return { status: "failed", error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Size the proxy cluster to the requested shards_count and return connection
 * info in the shape Fault Injector clients expect: they read
 * raw_endpoints[0], username, password, tls and bdb_id from the output.
 */
async function executeCreateDatabase(
	parameters: Record<string, unknown>,
	proxyStore: ProxyStore,
	config: ExtendedProxyConfig,
): Promise<ActionExecutionResult> {
	try {
		const databaseConfig = (parameters.database_config ?? {}) as Record<string, unknown>;
		const shardsCount =
			typeof databaseConfig.shards_count === "number" && databaseConfig.shards_count > 0
				? databaseConfig.shards_count
				: Math.max(proxyStore.proxies.length, 1);

		while (proxyStore.proxies.length > shardsCount) {
			const proxy = proxyStore.proxies.at(-1);
			if (!proxy) break;
			await removeNode(proxyStore, proxy);
		}
		while (proxyStore.proxies.length < shardsCount) {
			await startNode(proxyStore, { ...config, listenPort: nextListenPort(proxyStore, config) });
		}

		refreshClusterSlots(proxyStore);

		return {
			status: "success",
			output: {
				bdb_id: 1,
				username: "",
				password: "",
				tls: false,
				raw_endpoints: proxyStore.proxies.map((proxy) => ({
					dns_name: proxy.config.listenHost,
					port: proxy.config.listenPort,
				})),
			},
		};
	} catch (error) {
		return { status: "failed", error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Execute slot_migrate action - handles all scenario effects
 */
async function executeSlotMigrate(
	params: SlotMigrateParams,
	proxyStore: ProxyStore,
	config: ExtendedProxyConfig,
): Promise<ActionExecutionResult> {
	const { effect } = params;

	if (!effect) {
		return { status: "failed", error: "Missing required parameter: effect" };
	}

	const validEffects: SlotMigrateEffect[] = ["remove-add", "remove", "add", "slot-shuffle"];
	if (!validEffects.includes(effect)) {
		return {
			status: "failed",
			error: `Invalid effect: ${effect}. Must be one of: ${validEffects.join(", ")}`,
		};
	}

	try {
		switch (effect) {
			case "remove-add":
				await executeRemoveAddEffect(proxyStore, config);
				break;
			case "remove":
				await executeRemoveEffect(proxyStore, config);
				break;
			case "add":
				await executeAddEffect(proxyStore, config);
				break;
			case "slot-shuffle":
				await executeSlotShuffleEffect(proxyStore, config);
				break;
		}
		return { status: "success" };
	} catch (error) {
		return { status: "failed", error: error instanceof Error ? error.message : String(error) };
	}
}

async function executeRemoveAddEffect(
	proxyStore: ProxyStore,
	config: ExtendedProxyConfig,
): Promise<void> {
	const allProxies = proxyStore.proxies;
	if (allProxies.length === 0) {
		throw new Error("No proxies available to select from");
	}

	const proxyToBeRemoved = pickRandom(allProxies);
	if (!proxyToBeRemoved) {
		throw new Error("Failed to select a random proxy");
	}

	const slotRanges = getSlotRangesForProxy(proxyToBeRemoved, allProxies);
	const newPort = nextListenPort(proxyStore, config);
	const newProxyConfig: ProxyConfig = { ...config, listenPort: newPort };
	const { proxy: newProxy } = addNode(proxyStore, newProxyConfig);

	const proxiesForClusterSlots = allProxies.filter((p) => p !== proxyToBeRemoved).concat(newProxy);
	const clusterSlotsInterceptor = createCustomClusterSlotsInterceptor(proxiesForClusterSlots);

	for (const proxy of proxyStore.proxies) {
		proxy.addGlobalInterceptor(clusterSlotsInterceptor);
	}

	const sMigratingBuffer = buildSMigratingNotification(slotRanges, getNextSequenceId());
	sendToAllClients(proxyStore, sMigratingBuffer);
	const stopNotifying = pushToNewConnections(proxyStore, sMigratingBuffer);

	await delay(migrationDelayMs());

	const sMigratedBuffer = buildSMigratedNotification(
		[
			{
				targetNode: { host: newProxy.config.listenHost, port: newProxy.config.listenPort },
				slotRanges,
			},
		],
		getNextSequenceId(),
	);
	sendToAllClients(proxyStore, sMigratedBuffer);
	stopNotifying();

	await delay(completionDelayMs());

	await removeNode(proxyStore, proxyToBeRemoved);
}

async function executeRemoveEffect(
	proxyStore: ProxyStore,
	_config: ExtendedProxyConfig,
): Promise<void> {
	const allProxies = proxyStore.proxies;
	if (allProxies.length === 0) {
		throw new Error("No proxies available to select from");
	}
	if (allProxies.length === 1) {
		throw new Error("Cannot remove the last remaining node");
	}

	const proxyToBeRemoved = pickRandom(allProxies);
	if (!proxyToBeRemoved) {
		throw new Error("Failed to select a random proxy");
	}

	const removedNodeSlotRanges = getSlotRangesForProxy(proxyToBeRemoved, allProxies);
	const remainingProxies = allProxies.filter((p) => p !== proxyToBeRemoved);

	const newSlotDistribution = remainingProxies.map((proxy) => ({
		proxy,
		slotRanges: getSlotRangesForProxy(proxy, remainingProxies),
	}));

	const clusterSlotsInterceptor = createCustomClusterSlotsInterceptor(remainingProxies);
	for (const proxy of proxyStore.proxies) {
		proxy.addGlobalInterceptor(clusterSlotsInterceptor);
	}

	const sMigratingBuffer = buildSMigratingNotification(removedNodeSlotRanges, getNextSequenceId());
	sendToAllClients(proxyStore, sMigratingBuffer);
	const stopNotifying = pushToNewConnections(proxyStore, sMigratingBuffer);

	await delay(migrationDelayMs());

	const migratedSlots = newSlotDistribution.map(({ proxy, slotRanges }) => ({
		targetNode: { host: proxy.config.listenHost, port: proxy.config.listenPort },
		slotRanges,
	}));
	const sMigratedBuffer = buildSMigratedNotification(migratedSlots, getNextSequenceId());
	sendToAllClients(proxyStore, sMigratedBuffer);
	stopNotifying();

	await delay(completionDelayMs());

	await removeNode(proxyStore, proxyToBeRemoved);
}

async function executeAddEffect(
	proxyStore: ProxyStore,
	config: ExtendedProxyConfig,
): Promise<void> {
	const allProxies = proxyStore.proxies;
	if (allProxies.length === 0) {
		throw new Error("No proxies available");
	}

	const oldSlotDistribution = allProxies.map((proxy) => ({
		proxy,
		slotRanges: getSlotRangesForProxy(proxy, allProxies),
	}));

	const newPort = nextListenPort(proxyStore, config);
	const newProxyConfig: ProxyConfig = { ...config, listenPort: newPort };
	const { proxy: newProxy } = addNode(proxyStore, newProxyConfig);

	const allProxiesWithNew = [...allProxies, newProxy];
	const clusterSlotsInterceptor = createCustomClusterSlotsInterceptor(allProxiesWithNew);

	for (const proxy of proxyStore.proxies) {
		proxy.addGlobalInterceptor(clusterSlotsInterceptor);
	}

	let sMigratingBuffer: Buffer = Buffer.alloc(0);
	for (const { proxy, slotRanges } of oldSlotDistribution) {
		sMigratingBuffer = buildSMigratingNotification(slotRanges, getNextSequenceId());
		proxy.sendToAllClients(sMigratingBuffer);
	}
	const stopNotifying = pushToNewConnections(proxyStore, sMigratingBuffer);

	await delay(migrationDelayMs());

	const newNodeSlotRanges = getSlotRangesForProxy(newProxy, allProxiesWithNew);
	for (const { proxy } of oldSlotDistribution) {
		const sMigratedBuffer = buildSMigratedNotification(
			[
				{
					targetNode: { host: newProxy.config.listenHost, port: newProxy.config.listenPort },
					slotRanges: newNodeSlotRanges,
				},
			],
			getNextSequenceId(),
		);
		proxy.sendToAllClients(sMigratedBuffer);
	}
	stopNotifying();
}

async function executeSlotShuffleEffect(
	proxyStore: ProxyStore,
	_config: ExtendedProxyConfig,
): Promise<void> {
	const allProxies = proxyStore.proxies;
	if (allProxies.length === 0) {
		throw new Error("No proxies available");
	}
	if (allProxies.length === 1) {
		throw new Error("Cannot shuffle slots with only one node");
	}

	const oldSlotDistribution = allProxies.map((proxy) => ({
		proxy,
		slotRanges: getSlotRangesForProxy(proxy, allProxies),
	}));

	// Fisher-Yates shuffle
	const shuffledProxies = [...allProxies];
	for (let i = shuffledProxies.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		const temp = shuffledProxies[i];
		const jProxy = shuffledProxies[j];
		if (temp && jProxy) {
			shuffledProxies[i] = jProxy;
			shuffledProxies[j] = temp;
		}
	}

	const newSlotDistribution = shuffledProxies.map((proxy, index) => {
		const slotLength = Math.floor(16384 / shuffledProxies.length);
		const from = index * slotLength;
		const to = index === shuffledProxies.length - 1 ? 16383 : from + slotLength - 1;
		return { proxy, slotRanges: `${from}-${to}` };
	});

	const customShuffledInterceptor = {
		name: "cluster-simulation-interceptor",
		fn: async (
			data: Buffer,
			next: (data: Buffer) => Promise<Buffer>,
			state: { invokeCount: number; matchCount: number },
		) => {
			state.invokeCount++;
			if (data.toString().toLowerCase() !== "*2\r\n$7\r\ncluster\r\n$5\r\nslots\r\n") {
				return next(data);
			}
			state.matchCount++;
			const mapping = newSlotDistribution.map(({ proxy, slotRanges }) => {
				const [from, to] = slotRanges.split("-").map(Number);
				const id = `proxy-id-${proxy.config.listenPort}`;
				return `*3\r\n:${from}\r\n:${to}\r\n*3\r\n$${proxy.config.listenHost.length}\r\n${proxy.config.listenHost}\r\n:${proxy.config.listenPort}\r\n$${id.length}\r\n${id}\r\n`;
			});
			return Buffer.from(`*${newSlotDistribution.length}\r\n${mapping.join("")}`);
		},
	};

	for (const proxy of proxyStore.proxies) {
		proxy.addGlobalInterceptor(customShuffledInterceptor);
	}

	let sMigratingBuffer: Buffer = Buffer.alloc(0);
	for (const { proxy, slotRanges } of oldSlotDistribution) {
		sMigratingBuffer = buildSMigratingNotification(slotRanges, getNextSequenceId());
		proxy.sendToAllClients(sMigratingBuffer);
	}
	const stopNotifying = pushToNewConnections(proxyStore, sMigratingBuffer);

	await delay(migrationDelayMs());

	for (const { proxy: sourceProxy } of oldSlotDistribution) {
		const migratedSlots = newSlotDistribution.map(({ proxy, slotRanges }) => ({
			targetNode: { host: proxy.config.listenHost, port: proxy.config.listenPort },
			slotRanges,
		}));
		const sMigratedBuffer = buildSMigratedNotification(migratedSlots, getNextSequenceId());
		sourceProxy.sendToAllClients(sMigratedBuffer);
	}
	stopNotifying();
}
