import type { Context } from "hono";
import type { RedisProxy } from "redis-monorepo/packages/test-utils/lib/proxy/redis-proxy";
import type ProxyStore from "../proxy-store";

import type { ExtendedProxyConfig } from "../util";
import {
	buildSMigratedNotification,
	buildSMigratingNotification,
	getSlotRangesForProxy,
} from "./helpers";
import { getNextSequenceId } from "./sequence-gen";

/**
 * "SLOT SHUFFLE" Scenario:
 *
 * 1. Keep all existing nodes (no add/remove)
 * 2. Randomly shuffle slot assignments among existing nodes
 * 3. Intercept CLUSTER SLOTS to return the new shuffled slot distribution
 * 4. Send SMIGRATING notifications from nodes losing slots
 * 5. Send SMIGRATED notifications indicating the new slot ownership
 * 6. All nodes remain active with new slot assignments
 */
export default async function slotShuffleScenario(
	c: Context,
	proxyStore: ProxyStore,
	_config: ExtendedProxyConfig,
) {
	const allProxies = proxyStore.proxies;
	if (allProxies.length === 0) {
		return c.json(
			{
				success: false,
				error: "No proxies available",
			},
			400,
		);
	}

	if (allProxies.length === 1) {
		return c.json(
			{
				success: false,
				error: "Cannot shuffle slots with only one node",
			},
			400,
		);
	}

	// Step 1: Get current slot distribution
	const oldSlotDistribution = allProxies.map((proxy) => ({
		proxy,
		slotRanges: getSlotRangesForProxy(proxy, allProxies),
	}));

	// Step 2: Shuffle the proxies array to create a new slot distribution
	// We'll create a shuffled copy of the proxies array
	const shuffledProxies = [...allProxies];

	// Fisher-Yates shuffle algorithm
	for (let i = shuffledProxies.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		const temp = shuffledProxies[i];
		const jProxy = shuffledProxies[j];
		if (temp && jProxy) {
			shuffledProxies[i] = jProxy;
			shuffledProxies[j] = temp;
		}
	}

	// Step 3: Calculate new slot distribution based on shuffled order
	// We'll use the shuffled order to reassign slots
	const newSlotDistribution = shuffledProxies.map((proxy, index) => {
		const slotLength = Math.floor(16384 / shuffledProxies.length);
		const from = index * slotLength;
		const to = index === shuffledProxies.length - 1 ? 16383 : from + slotLength - 1;
		return {
			proxy,
			slotRanges: `${from}-${to}`,
		};
	});

	// Step 4: Create a custom interceptor that returns the shuffled slot distribution
	// We need to create a custom interceptor because the slots don't match the original order
	const customShuffledInterceptor = {
		name: "cluster-simulation-interceptor",
		fn: async (data: Buffer, next: any, state: any) => {
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

			const response = `*${newSlotDistribution.length}\r\n${mapping.join("")}`;
			return Buffer.from(response);
		},
	};

	for (const proxy of proxyStore.proxies) {
		proxy.addGlobalInterceptor(customShuffledInterceptor);
	}

	// Step 5: Send SMIGRATING notifications from all nodes
	// All nodes are potentially losing and gaining slots
	for (const { proxy, slotRanges } of oldSlotDistribution) {
		const sMigratingBuffer = buildSMigratingNotification(slotRanges, getNextSequenceId());
		proxy.sendToAllClients(sMigratingBuffer);
	}

	// Step 6: Send SMIGRATED notifications after a delay
	// This indicates the new slot ownership across all nodes
	setTimeout(() => {
		// Each node sends SMIGRATED showing where all slots now live
		for (const { proxy: sourceProxy } of oldSlotDistribution) {
			const migratedSlots = newSlotDistribution.map(({ proxy, slotRanges }) => ({
				targetNode: {
					host: proxy.config.listenHost,
					port: proxy.config.listenPort,
				},
				slotRanges,
			}));

			const sMigratedBuffer = buildSMigratedNotification(migratedSlots, getNextSequenceId());
			sourceProxy.sendToAllClients(sMigratedBuffer);
		}
	}, 5000);

	return c.json({
		success: true,
		scenario: "slot-shuffle",
		message: "Slot shuffle scenario started successfully",
		details: {
			oldDistribution: oldSlotDistribution.map(({ proxy, slotRanges }) => ({
				node: `${proxy.config.listenHost}:${proxy.config.listenPort}`,
				slots: slotRanges,
			})),
			newDistribution: newSlotDistribution.map(({ proxy, slotRanges }) => ({
				node: `${proxy.config.listenHost}:${proxy.config.listenPort}`,
				slots: slotRanges,
			})),
		},
	});
}
