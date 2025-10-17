import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { logger } from "hono/logger";
import type { ProxyConfig, ProxyStats, SendResult } from "redis-monorepo/packages/test-utils/lib/redis-proxy.ts";
import { RedisProxy } from "redis-monorepo/packages/test-utils/lib/redis-proxy.ts";

import {
	connectionIdsQuerySchema,
	encodingSchema,
	getConfig,
	paramSchema,
	parseBuffer,
  proxyConfigSchema,
} from "./util.ts";
import ProxyStore, { makeId } from "./proxy-store.ts";

const startNewProxy = (config: ProxyConfig) => {
  const proxy = new RedisProxy(config);
  proxy.setTransformations([
    // Transform PING to PING-TRANSFORMED
    (data: Buffer) => data.equals(Buffer.from('+PONG\r\n'))
      ? Buffer.from('+PONG-TRANSFORMED\r\n')
      : data,
    (data: Buffer) => {
      if(data.includes("$9\r\n127.0.0.1\r\n:3000")) {
        return Buffer.from(data.toString().replace(/\$9\r\n127\.0\.0\.1\r\n:3000/g, '$10\r\n127.0.0.11\r\n:3000'));
      }
      return data
    }
  ])
  proxy.start().catch(console.error);
  return proxy;
}

interface Mapping {
  from: {
    host: string,
    port: number
  },
  to: {
    host: string,
    port: number
  }
}

const addressMapping = new Map<string, Mapping>();

const setTransformers = (addressMapping: Map<string, Mapping>, proxyStore: ProxyStore) => {
  const transformers: Array<(data: Buffer) => Buffer> = [];
  for(const mapping of addressMapping.values()) {
    transformers.push((data: Buffer) => {
      // for example $9\r\n127.0.0.1\r\n:3000
      const fromPattern = `$${mapping.from.host.length}\r\n${mapping.from.host}\r\n:${mapping.from.port}`;
      if(data.includes(fromPattern)) {
        const toPattern = `$${mapping.to.host.length}\r\n${mapping.to.host}\r\n:${mapping.to.port}`;
        return Buffer.from(data.toString().replaceAll(fromPattern, toPattern));
      }
      return data;
    });
  }
  for(const proxy of proxyStore.proxies) {
    proxy.setTransformations(transformers);
  }
}


export function createApp(testConfig?: ProxyConfig & { readonly apiPort?: number }) {
	const config = testConfig || getConfig();
	const app = new Hono();
	app.use(logger());

  const proxyStore = new ProxyStore();
  const nodeId = makeId(config.targetHost, config.targetPort)
  proxyStore.add(nodeId, startNewProxy(config));
  addressMapping.set(nodeId, {
    from: {
      host: config.targetHost,
      port: config.targetPort
    },
    to: {
      host: config.listenHost ?? '127.0.0.1',
      port: config.listenPort
    }
  });
  setTransformers(addressMapping, proxyStore);

  app.post("/nodes",
    zValidator("json", proxyConfigSchema),
    async (c) => {
      const data = await c.req.json();
      const cfg: ProxyConfig = { ...config, ...data };
      const nodeId = makeId(cfg.targetHost, cfg.targetPort);
      proxyStore.add(nodeId, startNewProxy(cfg));
      addressMapping.set(nodeId, {
        from: {
          host: cfg.targetHost,
          port: cfg.targetPort
        },
        to: {
          host: cfg.listenHost ?? '127.0.0.1',
          port: cfg.listenPort
        }
      });
      setTransformers(addressMapping, proxyStore);
      return c.json({ success: true, cfg });
  });

  app.delete("/nodes/:id", async (c) => {
    const nodeId = c.req.param("id");
    const success = await proxyStore.delete(nodeId);
    addressMapping.delete(nodeId);
    setTransformers(addressMapping, proxyStore);
    return c.json({ success });
  });

  app.get("/nodes", (c) => {
    return c.json({ ids: proxyStore.nodeIds });
  });

	app.get("/stats", (c) => {
    const response = proxyStore.entries.reduce((acc, [id, proxy]) => {
      acc[id] = proxy.getStats();
      return acc;
    }, {} as Record<string, ProxyStats>);
		return c.json(response);
	});

	app.get("/connections", (c) => {
  	const response = proxyStore.entries.reduce((acc, [id, proxy]) => {
      acc[id] = proxy.getActiveConnectionIds();
      return acc;
    }, {} as Record<string, readonly string[]>)
		return c.json(response);
	});

	app.post(
		"/send-to-client/:connectionId",
		zValidator("param", paramSchema),
		zValidator("query", encodingSchema),
		async (c) => {
			const { connectionId } = c.req.valid("param");
			const { encoding } = c.req.valid("query");
			const data = await c.req.text();

			const buffer = parseBuffer(data, encoding);

      const proxy = proxyStore.getProxyByConnectionId(connectionId);
      if (!proxy) return c.json({
        success: false,
        error: 'Connection not found',
        connectionId
      });

			const result = proxy.sendToClient(connectionId, buffer);
			return c.json(result);
		},
	);

	app.post("/send-to-clients", zValidator("query", connectionIdsQuerySchema), async (c) => {
		const { connectionIds, encoding } = c.req.valid("query");
		const data = await c.req.text();

		const buffer = parseBuffer(data, encoding);

    const results: SendResult[] = [];
    for(const [proxy, matchingConIds] of proxyStore.getProxiesByConnectionIds(connectionIds)) {
  		results.push(...proxy.sendToClients(matchingConIds, buffer));
    }
		return c.json({ results });
	});

	app.post("/send-to-all-clients", zValidator("query", encodingSchema), async (c) => {
		const { encoding } = c.req.valid("query");
		const data = await c.req.text();
		const buffer = parseBuffer(data, encoding);
    const results: SendResult[] = [];
    for(const proxy of proxyStore.proxies) {
      results.push(...proxy.sendToAllClients(buffer));
    }
		return c.json({ results });
	});

  app.delete("/connections/:id", (c) => {
    const connectionId = c.req.param("id");
    const proxy = proxyStore.getProxyByConnectionId(connectionId);
    if (!proxy) return c.json({
      success: false,
      connectionId
    });
		const success = proxy.closeConnection(connectionId);
		return c.json({ success, connectionId });
	});

	return { app, proxy: proxyStore.proxies[0]!, config };
}
