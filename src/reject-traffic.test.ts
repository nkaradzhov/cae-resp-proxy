import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Socket } from "bun";

import { getFreePortNumber } from "redis-monorepo/packages/test-utils/lib/proxy/redis-proxy.ts";
import { createApp } from "./app";
import createMockRedisServer from "./mock-server";

describe("Reject traffic", () => {
	let app: any;
	let mockRedisServer: ReturnType<typeof createMockRedisServer>;
	let listenPort: number;
	let targetPort: number;

	const connectClient = async (port: number) => {
		let socket: Socket | undefined;
		let closed = false;
		let onClose = () => {};
		await new Promise<void>((resolve, reject) => {
			Bun.connect({
				hostname: "127.0.0.1",
				port,
				socket: {
					open(openedSocket) {
						socket = openedSocket;
						resolve();
					},
					data() {},
					error(_socket, error) {
						reject(error);
					},
					close() {
						closed = true;
						onClose();
					},
				},
			}).catch(reject);
		});
		return {
			isClosed: () => closed,
			waitForClose: () =>
				new Promise<void>((resolve, reject) => {
					if (closed) return resolve();
					onClose = resolve;
					setTimeout(() => reject(new Error("connection was not closed")), 2000);
				}),
			close: () => socket?.end(),
		};
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
			apiPort: 3003,
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

	test("start drops connections and refuses new ones, stop restores service", async () => {
		const client = await connectClient(listenPort);
		expect(client.isClosed()).toBe(false);

		const startRes = await app.request("/reject-traffic/start", { method: "POST" });
		expect(startRes.status).toBe(200);
		expect(await startRes.json()).toEqual({ success: true, rejecting: true });

		// The existing connection is dropped
		await client.waitForClose();

		// New connections are refused while rejecting
		await expect(connectClient(listenPort)).rejects.toThrow();

		const stopRes = await app.request("/reject-traffic/stop", { method: "POST" });
		expect(stopRes.status).toBe(200);
		expect(await stopRes.json()).toEqual({ success: true, rejecting: false });

		// Service is back: new connections are accepted again
		const revivedClient = await connectClient(listenPort);
		expect(revivedClient.isClosed()).toBe(false);
		revivedClient.close();
	});

	test("start and stop are idempotent", async () => {
		for (const _ of [1, 2]) {
			const res = await app.request("/reject-traffic/start", { method: "POST" });
			expect((await res.json()).rejecting).toBe(true);
		}
		for (const _ of [1, 2]) {
			const res = await app.request("/reject-traffic/stop", { method: "POST" });
			expect((await res.json()).rejecting).toBe(false);
		}

		const client = await connectClient(listenPort);
		expect(client.isClosed()).toBe(false);
		client.close();
	});
});
