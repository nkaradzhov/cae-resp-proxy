import {
	type InterceptorDescription,
	type InterceptorState,
	type Next,
	type ProxyConfig,
	RedisProxy,
	type SendResult,
} from "redis-monorepo/packages/test-utils/lib/proxy/redis-proxy";
import type ProxyStore from "../proxy-store";
import { makeId } from "../proxy-store";

/**
 * Starts a new proxy with the given configuration
 */
export function startNewProxy(config: ProxyConfig): RedisProxy {
	const proxy = new RedisProxy(config);
	proxy.start().catch(console.error);
	return proxy;
}

/**
 * Adds a new node to the proxy store
 */
export function addNode(
	proxyStore: ProxyStore,
	config: ProxyConfig,
): { nodeId: string; proxy: RedisProxy } {
	const nodeId = makeId(config.targetHost, config.targetPort, config.listenPort);
	const proxy = startNewProxy(config);
	proxyStore.add(nodeId, proxy);
	return { nodeId, proxy };
}

/**
 * Sends a buffer to all clients across all proxies
 */
export function sendToAllClients(proxyStore: ProxyStore, buffer: Buffer): SendResult[] {
	const results: SendResult[] = [];
	for (const proxy of proxyStore.proxies) {
		results.push(...proxy.sendToAllClients(buffer));
	}
	return results;
}

/**
 * Creates a cluster slots interceptor that returns a custom list of proxies
 */
export function createCustomClusterSlotsInterceptor(
	proxiesToInclude: RedisProxy[],
): InterceptorDescription {
	return {
		name: "cluster-simulation-interceptor",
		fn: async (data: Buffer, next: Next, state: InterceptorState) => {
			state.invokeCount++;

			if (data.toString().toLowerCase() !== "*2\r\n$7\r\ncluster\r\n$5\r\nslots\r\n") {
				return next(data);
			}

			state.matchCount++;

			const slotLength = Math.floor(16384 / proxiesToInclude.length);

			let current = -1;
			const mapping = proxiesToInclude.map((proxy, i) => {
				const from = current + 1;
				const to = i === proxiesToInclude.length - 1 ? 16383 : current + slotLength;
				current = to;
				const id = `proxy-id-${proxy.config.listenPort}`;
				return `*3\r\n:${from}\r\n:${to}\r\n*3\r\n$${proxy.config.listenHost.length}\r\n${proxy.config.listenHost}\r\n:${proxy.config.listenPort}\r\n$${id.length}\r\n${id}\r\n`;
			});

			const response = `*${proxiesToInclude.length}\r\n${mapping.join("")}`;
			return Buffer.from(response);
		},
	};
}

/**
 * Picks a random element from an array
 */
export function pickRandom<T>(array: T[]): T | undefined {
	if (array.length === 0) return undefined;
	return array[Math.floor(Math.random() * array.length)];
}

/**
 * Finds the next available port by incrementing from the highest existing port
 */
export function findNextAvailablePort(proxies: RedisProxy[]): number {
	const ports = proxies.map((p) => p.config.listenPort);
	return Math.max(...ports) + 1;
}

/**
 * Builds an SMIGRATING notification in RESP3 format
 * This notifies clients that slots are about to be migrated
 */
export function buildSMigratingNotification(slotRanges: string, seqId: number = 1): Buffer {
	const response = `>3\r\n+SMIGRATING\r\n:${seqId}\r\n+${slotRanges}\r\n`;
	return Buffer.from(response);
}

/**
 * Builds an SMIGRATED notification in RESP3 format
 * This notifies clients that slots have been migrated to different nodes
 */
export function buildSMigratedNotification(
	movedSlotsByDestination: Array<{
		targetNode: { host: string; port: number };
		slotRanges: string; // e.g., "0-5460" or "0-100,200-300,500"
	}>,
	seqId: number = 1,
): Buffer {
	if (movedSlotsByDestination.length === 0) {
		throw new Error("No slots to migrate");
	}

	const entries = movedSlotsByDestination.map(({ targetNode, slotRanges }) => {
		const hostPort = `${targetNode.host}:${targetNode.port}`;
		return `*2\r\n+${hostPort}\r\n+${slotRanges}\r\n`;
	});

	const response = `>3\r\n+SMIGRATED\r\n:${seqId}\r\n*${movedSlotsByDestination.length}\r\n${entries.join("")}`;

	return Buffer.from(response);
}

/**
 * Gets the slot ranges assigned to a specific proxy based on cluster slot distribution
 */
export function getSlotRangesForProxy(proxy: RedisProxy, allProxies: RedisProxy[]): string {
	const proxyIndex = allProxies.indexOf(proxy);
	if (proxyIndex === -1) {
		throw new Error("Proxy not found in the list");
	}

	const slotLength = Math.floor(16384 / allProxies.length);
	const from = proxyIndex * slotLength;
	const to = proxyIndex === allProxies.length - 1 ? 16383 : from + slotLength - 1;

	return `${from}-${to}`;
}
