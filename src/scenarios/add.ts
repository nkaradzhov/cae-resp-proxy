import type { Context } from "hono";
import type { ProxyConfig } from "redis-monorepo/packages/test-utils/lib/proxy/redis-proxy";
import type ProxyStore from "../proxy-store";

import type { ExtendedProxyConfig } from "../util";
import {
	addNode,
	buildSMigratedNotification,
	buildSMigratingNotification,
	createCustomClusterSlotsInterceptor,
	findNextAvailablePort,
	getSlotRangesForProxy,
} from "./helpers";
import { getNextSequenceId } from "./sequence-gen";

/**
 * "ADD NODE" Scenario:
 *
 * 1. Add a new node to the cluster
 * 2. Calculate new slot distribution (slots redistributed from existing nodes to new node)
 * 3. Intercept CLUSTER SLOTS to return all nodes (existing + new) with updated slot ranges
 * 4. Send SMIGRATING notifications from nodes that will lose slots
 * 5. Send SMIGRATED notifications indicating slots moved to the new node
 * 6. All nodes remain active
 */
export default async function addNodeScenario(
	c: Context,
	proxyStore: ProxyStore,
	config: ExtendedProxyConfig,
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

	// Step 1: Get current slot distribution before adding new node
	const oldSlotDistribution = allProxies.map((proxy) => ({
		proxy,
		slotRanges: getSlotRangesForProxy(proxy, allProxies),
	}));

	// Step 2: Add a new node
	const newPort = findNextAvailablePort(allProxies);
	const newProxyConfig: ProxyConfig = {
		...config,
		listenPort: newPort,
	};

	const { nodeId: newNodeId, proxy: newProxy } = addNode(proxyStore, newProxyConfig);

	// Step 3: Calculate new slot distribution with the new node included
	const allProxiesWithNew = [...allProxies, newProxy];
	const newSlotDistribution = allProxiesWithNew.map((proxy) => ({
		proxy,
		slotRanges: getSlotRangesForProxy(proxy, allProxiesWithNew),
	}));

	// Step 4: Intercept CLUSTER SLOTS to return all nodes with new distribution
	const clusterSlotsInterceptor = createCustomClusterSlotsInterceptor(allProxiesWithNew);

	for (const proxy of proxyStore.proxies) {
		proxy.addGlobalInterceptor(clusterSlotsInterceptor);
	}

	// Step 5: Send SMIGRATING notifications from nodes that will lose slots
	// Each existing node loses some slots to make room for the new node
	for (const { proxy, slotRanges } of oldSlotDistribution) {
		const sMigratingBuffer = buildSMigratingNotification(slotRanges, getNextSequenceId());
		proxy.sendToAllClients(sMigratingBuffer);
	}

	// Step 6: Send SMIGRATED notifications after a delay
	// This indicates where slots have moved (to the new node)
	setTimeout(() => {
		const newNodeSlotRanges = getSlotRangesForProxy(newProxy, allProxiesWithNew);

		// Send SMIGRATED from each old node indicating their slots moved to new node
		for (const { proxy } of oldSlotDistribution) {
			const sMigratedBuffer = buildSMigratedNotification(
				[
					{
						targetNode: {
							host: newProxy.config.listenHost,
							port: newProxy.config.listenPort,
						},
						slotRanges: newNodeSlotRanges,
					},
				],
				getNextSequenceId(),
			);
			proxy.sendToAllClients(sMigratedBuffer);
		}
	}, 5000);

	return c.json({
		success: true,
		scenario: "add",
		message: "Add node scenario started successfully",
		details: {
			newNode: `${newProxy.config.listenHost}:${newProxy.config.listenPort}`,
			newNodeId,
			newNodeSlots: getSlotRangesForProxy(newProxy, allProxiesWithNew),
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
