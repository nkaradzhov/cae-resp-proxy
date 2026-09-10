import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Socket } from "bun";

import { getFreePortNumber } from "redis-monorepo/packages/test-utils/lib/proxy/redis-proxy.ts";
import { createApp } from "./app";
import createMockRedisServer from "./mock-server";

// Shrink the migration windows so the suite stays fast. The action code reads
// these at execution time.
process.env.MIGRATION_DELAY_MS = "300";
process.env.COMPLETION_DELAY_MS = "100";

interface ActionStatusResponse {
	status: string;
	error: unknown;
	output: unknown;
}

describe("Fault Injector action API", () => {
	let app: any;
	let mockRedisServer: ReturnType<typeof createMockRedisServer>;
	let listenPort: number;
	let targetPort: number;

	const postAction = async (body: unknown): Promise<Response> => {
		return app.request("/action", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	};

	const submitAction = async (body: unknown): Promise<string> => {
		const res = await postAction(body);
		expect(res.status).toBe(200);
		const { action_id } = (await res.json()) as { action_id: string };
		expect(action_id).toBeString();
		return action_id;
	};

	const waitForAction = async (actionId: string): Promise<ActionStatusResponse> => {
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			const res = await app.request(`/action/${actionId}`);
			expect(res.status).toBe(200);
			const action = (await res.json()) as ActionStatusResponse;
			if (action.status !== "pending" && action.status !== "running") {
				return action;
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		throw new Error(`Timeout waiting for action ${actionId}`);
	};

	const runAction = async (body: unknown): Promise<ActionStatusResponse> => {
		return waitForAction(await submitAction(body));
	};

	const getNodeIds = async (): Promise<string[]> => {
		const res = await app.request("/nodes");
		return (await res.json()).ids;
	};

	const resetCluster = async () => {
		const result = await runAction({ type: "reset_cluster", parameters: {} });
		expect(result.status).toBe("success");
	};

	beforeAll(async () => {
		listenPort = await getFreePortNumber();
		targetPort = await getFreePortNumber();

		mockRedisServer = createMockRedisServer(targetPort);

		const appInstance = createApp({
			listenPort: [listenPort],
			listenHost: "127.0.0.1",
			targetHost: "127.0.0.1",
			targetPort: targetPort,
			timeout: 30000,
			enableLogging: false,
			apiPort: 3002,
		});
		app = appInstance.app;

		await new Promise((resolve) => setTimeout(resolve, 200));
	});

	afterAll(async () => {
		const res = await app.request("/nodes");
		const { ids } = await res.json();
		for (const id of ids) {
			await app.request(`/nodes/${encodeURIComponent(id)}`, { method: "DELETE" });
		}
		mockRedisServer?.stop(true);
	});

	test("POST /action rejects unknown action types", async () => {
		const res = await postAction({ type: "bogus", parameters: {} });
		expect(res.status).toBe(400);
	});

	test("GET /slot-migrate returns FI-shaped triggers", async () => {
		const res = await app.request("/slot-migrate?effect=remove");
		expect(res.status).toBe(200);

		const body = await res.json();
		expect(body.effect).toBe("remove");
		expect(body.cluster.index).toBe(0);
		expect(body.cluster.nodes).toBeNumber();

		const names = body.triggers.map((trigger: { name: string }) => trigger.name);
		expect(names).toEqual(["migrate", "maintenance_mode", "failover"]);

		for (const trigger of body.triggers) {
			expect(trigger.description).toBeString();
			expect(trigger.requirements.length).toBeGreaterThan(0);
			for (const requirement of trigger.requirements) {
				expect(requirement.dbconfig.name).toBeString();
				expect(requirement.dbconfig.name).toContain("sm-remove-");
				expect(requirement.dbconfig.shards_count).toBeNumber();
				expect(requirement.cluster.min_nodes).toBe(3);
				expect(requirement.description).toBeString();
			}
		}

		// The --db=ext-hostname CLI filter of the scenario tests matches on this
		const dbNames = body.triggers.flatMap(
			(trigger: { requirements: { dbconfig: { name: string } }[] }) =>
				trigger.requirements.map((requirement) => requirement.dbconfig.name),
		);
		expect(dbNames.some((name: string) => name.includes("ext-ip"))).toBe(true);
		expect(dbNames.some((name: string) => name.includes("ext-hostname"))).toBe(true);
	});

	test("GET /slot-migrate requires an effect", async () => {
		const res = await app.request("/slot-migrate");
		expect(res.status).toBe(400);
	});

	test("create_database sizes the cluster and returns connection info", async () => {
		const result = await runAction({
			type: "create_database",
			parameters: {
				cluster_index: 0,
				database_config: { name: "sm-remove-migrate-ext-ip", shards_count: 3 },
			},
		});

		expect(result.status).toBe("success");
		const output = result.output as {
			bdb_id: number;
			username: string;
			password: string;
			tls: boolean;
			raw_endpoints: { dns_name: string; port: number }[];
		};
		expect(output.bdb_id).toBeNumber();
		expect(output.tls).toBe(false);
		expect(output.raw_endpoints.length).toBe(3);
		expect(output.raw_endpoints[0]?.dns_name).toBe("127.0.0.1");
		expect(output.raw_endpoints[0]?.port).toBeNumber();

		expect((await getNodeIds()).length).toBe(3);
	});

	test("reset_cluster restores the initial topology", async () => {
		await resetCluster();
		expect((await getNodeIds()).length).toBe(1);
	});

	test("GET /action lists submitted actions", async () => {
		const actionId = await submitAction({ type: "wait", parameters: {} });
		await waitForAction(actionId);

		const res = await app.request("/action");
		expect(res.status).toBe(200);
		const { actions } = await res.json();
		const entry = actions.find((action: { job_id: string }) => action.job_id === actionId);
		expect(entry).toBeDefined();
		expect(entry.action_type).toBe("wait");
		expect(entry.submitted_at).toBeString();
	});

	test("slot_migrate rejects an invalid effect", async () => {
		const result = await runAction({
			type: "slot_migrate",
			parameters: { effect: "explode", cluster_index: 0 },
		});
		expect(result.status).toBe("failed");
		expect(String(result.error)).toContain("Invalid effect");
	});

	test("slot_migrate remove notifies all clients and new connections", async () => {
		await resetCluster();
		const createResult = await runAction({
			type: "create_database",
			parameters: {
				cluster_index: 0,
				database_config: { name: "sm-remove-migrate-ext-ip", shards_count: 3 },
			},
		});
		const { raw_endpoints } = createResult.output as {
			raw_endpoints: { dns_name: string; port: number }[];
		};
		expect(raw_endpoints.length).toBe(3);

		const connectAndCollect = async (port: number) => {
			const chunks: Buffer[] = [];
			let socket: Socket | undefined;
			await new Promise<void>((resolve, reject) => {
				Bun.connect({
					hostname: "127.0.0.1",
					port,
					socket: {
						open(openedSocket) {
							socket = openedSocket;
							resolve();
						},
						data(_socket, data) {
							chunks.push(Buffer.from(data));
						},
						error(_socket, error) {
							reject(error);
						},
						close() {},
					},
				});
			});
			return {
				received: () => Buffer.concat(chunks).toString(),
				close: () => socket?.end(),
			};
		};

		const clients = await Promise.all(
			raw_endpoints.map((endpoint) => connectAndCollect(endpoint.port)),
		);
		// Let the proxies register the connections
		await new Promise((resolve) => setTimeout(resolve, 100));

		const actionId = await submitAction({
			type: "slot_migrate",
			parameters: { effect: "remove", cluster_index: 0, trigger: "migrate", bdb_id: "1" },
		});

		// SMIGRATING is broadcast right away; the migration window is 300ms
		await new Promise((resolve) => setTimeout(resolve, 100));
		for (const client of clients) {
			expect(client.received()).toContain("SMIGRATING");
		}

		// A connection opened during the migration window gets SMIGRATING too
		const lateClient = await connectAndCollect(raw_endpoints[0]?.port as number);
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(lateClient.received()).toContain("SMIGRATING");

		const result = await waitForAction(actionId);
		expect(result.status).toBe("success");

		// One node was removed and the survivors got SMIGRATED
		expect((await getNodeIds()).length).toBe(2);
		const migrated = clients.filter((client) => client.received().includes("SMIGRATED"));
		expect(migrated.length).toBeGreaterThan(0);

		lateClient.close();
		for (const client of clients) {
			client.close();
		}
	});
});
