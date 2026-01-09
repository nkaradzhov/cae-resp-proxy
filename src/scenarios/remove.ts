import type { Context } from "hono";
import type ProxyStore from "../proxy-store";

import { makeId } from "../proxy-store";
import type { ExtendedProxyConfig } from "../util";
import {
	buildSMigratedNotification,
	buildSMigratingNotification,
	createCustomClusterSlotsInterceptor,
	getSlotRangesForProxy,
	pickRandom,
} from "./helpers";
import { getNextSequenceId } from "./sequence-gen";

/**
 * "REMOVE NODE" Scenario:
 *
 * 1. Pick a random node from existing proxies to remove
 * 2. Get the slot ranges currently assigned to that node
 * 3. Calculate new slot distribution among remaining nodes
 * 4. Intercept CLUSTER SLOTS to return all nodes except the one being removed
 * 5. Send SMIGRATING notification from the node being removed
 * 6. Send SMIGRATED notifications indicating where slots moved (to remaining nodes)
 * 7. Kill/delete the removed node after notifications
 */
export default async function removeNodeScenario(
	c: Context,
	proxyStore: ProxyStore,
	_config: ExtendedProxyConfig,
) {
	// Step 1: Pick a random node to remove
	const allProxies = proxyStore.proxies;
	if (allProxies.length === 0) {
		return c.json(
			{
				success: false,
				error: "No proxies available to select from",
			},
			400,
		);
	}

	if (allProxies.length === 1) {
		return c.json(
			{
				success: false,
				error: "Cannot remove the last remaining node",
			},
			400,
		);
	}

	const proxyToBeRemoved = pickRandom(allProxies);
	if (!proxyToBeRemoved) {
		return c.json(
			{
				success: false,
				error: "Failed to select a random proxy",
			},
			400,
		);
	}

	// Step 2: Get the slot ranges for the node being removed
	const removedNodeSlotRanges = getSlotRangesForProxy(proxyToBeRemoved, allProxies);

	// Step 3: Create list of remaining proxies (excluding the one being removed)
	const remainingProxies = allProxies.filter((p) => p !== proxyToBeRemoved);

	// Calculate new slot distribution for remaining nodes
	const newSlotDistribution = remainingProxies.map((proxy) => ({
		proxy,
		slotRanges: getSlotRangesForProxy(proxy, remainingProxies),
	}));

	// Step 4: Intercept CLUSTER SLOTS to return only remaining nodes
	const clusterSlotsInterceptor = createCustomClusterSlotsInterceptor(remainingProxies);

	for (const proxy of proxyStore.proxies) {
		proxy.addGlobalInterceptor(clusterSlotsInterceptor);
	}

	// Step 5: Send SMIGRATING notification from the node being removed
	const sMigratingBuffer = buildSMigratingNotification(removedNodeSlotRanges, getNextSequenceId());
	proxyToBeRemoved.sendToAllClients(sMigratingBuffer);

	// Step 6: Send SMIGRATED notifications after a delay
	// This indicates where slots from the removed node have moved (distributed to remaining nodes)
	setTimeout(() => {
		// Build SMIGRATED notification showing slots redistributed to remaining nodes
		const migratedSlots = newSlotDistribution.map(({ proxy, slotRanges }) => ({
			targetNode: {
				host: proxy.config.listenHost,
				port: proxy.config.listenPort,
			},
			slotRanges,
		}));

		const sMigratedBuffer = buildSMigratedNotification(migratedSlots, getNextSequenceId());
		proxyToBeRemoved.sendToAllClients(sMigratedBuffer);

		// Step 7: Kill the removed node after another delay
		setTimeout(() => {
			const { targetHost, targetPort, listenPort } = proxyToBeRemoved.config;
			proxyStore.delete(makeId(targetHost, targetPort, listenPort));
		}, 2000);
	}, 5000);

	return c.json({
		success: true,
		scenario: "remove",
		message: "Remove node scenario started successfully",
		details: {
			removedNode: `${proxyToBeRemoved.config.listenHost}:${proxyToBeRemoved.config.listenPort}`,
			removedNodeSlots: removedNodeSlotRanges,
			remainingNodes: remainingProxies.map((p) => ({
				node: `${p.config.listenHost}:${p.config.listenPort}`,
			})),
			newDistribution: newSlotDistribution.map(({ proxy, slotRanges }) => ({
				node: `${proxy.config.listenHost}:${proxy.config.listenPort}`,
				slots: slotRanges,
			})),
		},
	});
}
