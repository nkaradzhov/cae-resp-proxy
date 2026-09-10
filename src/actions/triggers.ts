import type { ActionTrigger, ActionTriggerRequirement, SlotMigrateEffect } from "../util";

// Mirrors re_fault_injector TRIGGER_DEFINITIONS so clients can select
// triggers by their real names (migrate, maintenance_mode, failover).
const TRIGGER_DEFINITIONS: Record<SlotMigrateEffect, { name: string; description: string }[]> = {
	"remove-add": [
		{
			name: "migrate",
			description: "Use rladmin migrate to move all shards from source node to empty node",
		},
		{
			name: "maintenance_mode",
			description: "Put source node in maintenance mode, shards auto-migrate to other nodes",
		},
		{
			name: "failover",
			description: "Trigger failover to swap master/replica roles (requires replication)",
		},
	],
	remove: [
		{
			name: "migrate",
			description: "Use rladmin migrate to move all shards from source node to existing node",
		},
		{
			name: "maintenance_mode",
			description: "Put source node in maintenance mode, shards auto-migrate to other nodes",
		},
		{
			name: "failover",
			description: "Trigger failover to swap master/replica roles (requires replication)",
		},
	],
	add: [
		{ name: "migrate", description: "Use rladmin migrate to move one shard to empty node" },
		{
			name: "failover",
			description: "Trigger failover to swap master/replica roles (requires replication)",
		},
	],
	"slot-shuffle": [
		{
			name: "migrate",
			description: "Use rladmin migrate to move one shard between existing nodes",
		},
		{
			name: "failover",
			description: "Trigger failover to swap master/replica roles (requires replication)",
		},
	],
};

// The two default (external) OSS Cluster API combinations the FI returns.
const IP_TYPES = [
	{ ipType: "external", endpointType: "ip", suffix: "ext-ip" },
	{ ipType: "external", endpointType: "hostname", suffix: "ext-hostname" },
];

const MIN_NODES = 3;
const BASE_PORT = 13000;

// Mirrors re_fault_injector _calculate_shards_count. For the proxy,
// shards_count doubles as the number of proxy nodes create_database spins up.
function calculateShardsCount(effect: SlotMigrateEffect, trigger: string, nodeCount: number) {
	switch (effect) {
		case "remove-add":
			return trigger === "failover" ? 1 : nodeCount - 1;
		case "remove":
			return nodeCount;
		case "add":
			return trigger === "failover" ? 2 : nodeCount;
		case "slot-shuffle":
			return nodeCount * 2;
	}
}

function calculatePlacement(effect: SlotMigrateEffect, trigger: string) {
	if (effect === "add") return "dense";
	if (effect === "remove-add" && trigger === "maintenance_mode") return "dense";
	return "sparse";
}

export function generateTriggersForEffect(
	effect: SlotMigrateEffect,
	nodeCount: number,
): ActionTrigger[] {
	// The FI derives shards_count from the RE cluster size and needs >= 3 nodes
	// for quorum. The proxy has no quorum and can add nodes freely, so size the
	// dbconfigs as if the cluster had at least MIN_NODES.
	const effectiveNodes = Math.max(nodeCount, MIN_NODES);

	return TRIGGER_DEFINITIONS[effect].map((trigger) => ({
		name: trigger.name,
		description: trigger.description,
		requirements: IP_TYPES.map(({ ipType, endpointType, suffix }, index) => {
			const requirement: ActionTriggerRequirement = {
				dbconfig: {
					name: `sm-${effect}-${trigger.name.replace(/_/g, "-")}-${suffix}`,
					port: BASE_PORT + index,
					memory_size: 134217728,
					eviction_policy: "volatile-lru",
					sharding: true,
					oss_cluster: true,
					proxy_policy: "all-master-shards",
					shards_count: calculateShardsCount(effect, trigger.name, effectiveNodes),
					shards_placement: calculatePlacement(effect, trigger.name),
					replication: trigger.name === "failover",
					oss_cluster_api_preferred_ip_type: ipType,
					oss_cluster_api_preferred_endpoint_type: endpointType,
				},
				cluster: { min_nodes: MIN_NODES, actual_nodes: nodeCount },
				oss_cluster_api: { ip_type: ipType, endpoint_type: endpointType },
				description: `Config (${ipType}/${endpointType})`,
			};
			return requirement;
		}),
	}));
}
