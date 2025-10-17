import type { RedisProxy } from "redis-monorepo/packages/test-utils/lib/redis-proxy";

export const makeId = (host: string, port: number) => `${host}:${port}`;

export default class ProxyStore {
  #proxies = new Map<string, RedisProxy>();

  add(id: string, proxy: RedisProxy) {
    this.#proxies.set(id, proxy);
  }

  async delete(id: string) {
    const proxy = this.#proxies.get(id);
    if (!proxy) return false;
    await proxy.stop();
    this.#proxies.delete(id);
  }

  get nodeIds() {
    return Array.from(this.#proxies.keys());
  }

  get proxies() {
    return Array.from(this.#proxies.values());
  }

  get entries() {
    return Array.from(this.#proxies.entries());
  }

  getProxyByConnectionId(connectionId: string) {
    for (const proxy of this.#proxies.values()) {
      if (proxy.getActiveConnectionIds().includes(connectionId)) {
        return proxy;
      }
    }
  }

  getProxiesByConnectionIds(connectionIds: string[]) {
    const result: [RedisProxy, string[]][] = [];
    for (const proxy of this.#proxies.values()) {
      const activeIds = proxy.getActiveConnectionIds();
      const matchingIds = connectionIds.filter((id) => activeIds.includes(id));
      if (matchingIds.length > 0) {
        result.push([proxy, matchingIds]);
      }
    }
    return result;
  }

}
