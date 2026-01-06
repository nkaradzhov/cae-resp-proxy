import type { Context } from "hono";
import type { ProxyConfig } from "redis-monorepo/packages/test-utils/lib/proxy/redis-proxy";
import type ProxyStore from "../proxy-store";

import { makeId } from "../proxy-store";
import type { ExtendedProxyConfig } from "../util";
import {
	addNode,
	buildSMigratedNotification,
	buildSMigratingNotification,
	createCustomClusterSlotsInterceptor,
	findNextAvailablePort,
	getSlotRangesForProxy,
	pickRandom,
} from "./helpers";
import { getNextSequenceId } from "./sequence-gen";

/**
 *  "REMOVED AND ADDED" Scenario:
 *
 * 1. Pick a random node from existing proxies
 * 2. Add one more node
 * 3. Intercept CLUSTER SLOTS to return all nodes + the new one - the randomly selected one
 * 4. Send SMIGRATING notification to all clients (slots about to be migrated)
 * 5. Send SMIGRATED notification to all clients (slots migrated from picked node to new node)
 * 6. Kill the old node
 */
export default async function removeSrcAddDestScenario(
	c: Context,
	proxyStore: ProxyStore,
	config: ExtendedProxyConfig,
) {
	// Step 1: Pick a random node
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

	// Get the slot ranges for the randomly selected proxy before adding the new node
	const slotRanges = getSlotRangesForProxy(proxyToBeRemoved, allProxies);

	// Step 2: Add one more node
	const newPort = findNextAvailablePort(allProxies);
	const newProxyConfig: ProxyConfig = {
		...config,
		listenPort: newPort,
	};

	const { nodeId: newNodeId, proxy: newProxy } = addNode(proxyStore, newProxyConfig);

	// Step 3: Create list of proxies excluding the randomly selected one, and including the new one
	const proxiesForClusterSlots = allProxies.filter((p) => p !== proxyToBeRemoved).concat(newProxy);

	// Add the custom cluster slots interceptor to all proxies
	const clusterSlotsInterceptor = createCustomClusterSlotsInterceptor(proxiesForClusterSlots);

	for (const proxy of proxyStore.proxies) {
		proxy.addGlobalInterceptor(clusterSlotsInterceptor);
	}

	// Step 4: Send SMIGRATING notification to all clients
	// This notifies clients that slots are about to be migrated
	const sMigratingBuffer = buildSMigratingNotification(slotRanges, getNextSequenceId());
	proxyToBeRemoved.sendToAllClients(sMigratingBuffer);

	// Step 5: Send SMIGRATED notification to all clients
	// This notifies clients that slots from the picked node have moved to the new node
	setTimeout(() => {
		const sMigratedBuffer = buildSMigratedNotification(
			[
				{
					targetNode: {
						host: newProxy.config.listenHost,
						port: newProxy.config.listenPort,
					},
					slotRanges,
				},
			],
			getNextSequenceId(),
		);
		proxyToBeRemoved.sendToAllClients(sMigratedBuffer);

		setTimeout(() => {
			const { targetHost, targetPort, listenPort } = proxyToBeRemoved.config;
			proxyStore.delete(makeId(targetHost, targetPort, listenPort));
		}, 2000);
	}, 5000);

	return c.json({
		success: true,
		scenario: "foo",
		message: "Foo scenario started successfully",
		details: {
			excludedNode: `${proxyToBeRemoved.config.listenHost}:${proxyToBeRemoved.config.listenPort}`,
			newNode: `${newProxy.config.listenHost}:${newProxy.config.listenPort}`,
			newNodeId,
			migratedSlots: slotRanges,
			clusterSlotsProxies: proxiesForClusterSlots.map((p) => ({
				host: p.config.listenHost,
				port: p.config.listenPort,
			})),
		},
	});
}
