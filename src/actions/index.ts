import type { ProxyConfig } from "redis-monorepo/packages/test-utils/lib/proxy/redis-proxy";
import type ProxyStore from "../proxy-store";
import { makeId } from "../proxy-store";
import type { ActionType, ExtendedProxyConfig } from "../util";
import {
	addNode,
	buildSMigratedNotification,
	buildSMigratingNotification,
	createCustomClusterSlotsInterceptor,
	findNextAvailablePort,
	getSlotRangesForProxy,
	pickRandom,
} from "../scenarios/helpers";
import { getNextSequenceId } from "../scenarios/sequence-gen";

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
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
		default:
			return { status: "success" };
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
		return { status: "failed", error: `Invalid effect: ${effect}. Must be one of: ${validEffects.join(", ")}` };
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

async function executeRemoveAddEffect(proxyStore: ProxyStore, config: ExtendedProxyConfig): Promise<void> {
	const allProxies = proxyStore.proxies;
	if (allProxies.length === 0) {
		throw new Error("No proxies available to select from");
	}

	const proxyToBeRemoved = pickRandom(allProxies);
	if (!proxyToBeRemoved) {
		throw new Error("Failed to select a random proxy");
	}

	const slotRanges = getSlotRangesForProxy(proxyToBeRemoved, allProxies);
	const newPort = findNextAvailablePort(allProxies);
	const newProxyConfig: ProxyConfig = { ...config, listenPort: newPort };
	const { proxy: newProxy } = addNode(proxyStore, newProxyConfig);

	const proxiesForClusterSlots = allProxies.filter((p) => p !== proxyToBeRemoved).concat(newProxy);
	const clusterSlotsInterceptor = createCustomClusterSlotsInterceptor(proxiesForClusterSlots);

	for (const proxy of proxyStore.proxies) {
		proxy.addGlobalInterceptor(clusterSlotsInterceptor);
	}

	const sMigratingBuffer = buildSMigratingNotification(slotRanges, getNextSequenceId());
	proxyToBeRemoved.sendToAllClients(sMigratingBuffer);

	await delay(5000);

	const sMigratedBuffer = buildSMigratedNotification(
		[{ targetNode: { host: newProxy.config.listenHost, port: newProxy.config.listenPort }, slotRanges }],
		getNextSequenceId(),
	);
	proxyToBeRemoved.sendToAllClients(sMigratedBuffer);

	await delay(2000);

	const { targetHost, targetPort, listenPort } = proxyToBeRemoved.config;
	await proxyStore.delete(makeId(targetHost, targetPort, listenPort));
}

async function executeRemoveEffect(proxyStore: ProxyStore, _config: ExtendedProxyConfig): Promise<void> {
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
	proxyToBeRemoved.sendToAllClients(sMigratingBuffer);

	await delay(5000);

	const migratedSlots = newSlotDistribution.map(({ proxy, slotRanges }) => ({
		targetNode: { host: proxy.config.listenHost, port: proxy.config.listenPort },
		slotRanges,
	}));
	const sMigratedBuffer = buildSMigratedNotification(migratedSlots, getNextSequenceId());
	proxyToBeRemoved.sendToAllClients(sMigratedBuffer);

	await delay(2000);

	const { targetHost, targetPort, listenPort } = proxyToBeRemoved.config;
	await proxyStore.delete(makeId(targetHost, targetPort, listenPort));
}

async function executeAddEffect(proxyStore: ProxyStore, config: ExtendedProxyConfig): Promise<void> {
	const allProxies = proxyStore.proxies;
	if (allProxies.length === 0) {
		throw new Error("No proxies available");
	}

	const oldSlotDistribution = allProxies.map((proxy) => ({
		proxy,
		slotRanges: getSlotRangesForProxy(proxy, allProxies),
	}));

	const newPort = findNextAvailablePort(allProxies);
	const newProxyConfig: ProxyConfig = { ...config, listenPort: newPort };
	const { proxy: newProxy } = addNode(proxyStore, newProxyConfig);

	const allProxiesWithNew = [...allProxies, newProxy];
	const clusterSlotsInterceptor = createCustomClusterSlotsInterceptor(allProxiesWithNew);

	for (const proxy of proxyStore.proxies) {
		proxy.addGlobalInterceptor(clusterSlotsInterceptor);
	}

	for (const { proxy, slotRanges } of oldSlotDistribution) {
		const sMigratingBuffer = buildSMigratingNotification(slotRanges, getNextSequenceId());
		proxy.sendToAllClients(sMigratingBuffer);
	}

	await delay(5000);

	const newNodeSlotRanges = getSlotRangesForProxy(newProxy, allProxiesWithNew);
	for (const { proxy } of oldSlotDistribution) {
		const sMigratedBuffer = buildSMigratedNotification(
			[{ targetNode: { host: newProxy.config.listenHost, port: newProxy.config.listenPort }, slotRanges: newNodeSlotRanges }],
			getNextSequenceId(),
		);
		proxy.sendToAllClients(sMigratedBuffer);
	}
}

async function executeSlotShuffleEffect(proxyStore: ProxyStore, _config: ExtendedProxyConfig): Promise<void> {
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
		fn: async (data: Buffer, next: (data: Buffer) => Promise<Buffer>, state: { invokeCount: number; matchCount: number }) => {
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

	for (const { proxy, slotRanges } of oldSlotDistribution) {
		const sMigratingBuffer = buildSMigratingNotification(slotRanges, getNextSequenceId());
		proxy.sendToAllClients(sMigratingBuffer);
	}

	await delay(5000);

	for (const { proxy: sourceProxy } of oldSlotDistribution) {
		const migratedSlots = newSlotDistribution.map(({ proxy, slotRanges }) => ({
			targetNode: { host: proxy.config.listenHost, port: proxy.config.listenPort },
			slotRanges,
		}));
		const sMigratedBuffer = buildSMigratedNotification(migratedSlots, getNextSequenceId());
		sourceProxy.sendToAllClients(sMigratedBuffer);
	}
}
