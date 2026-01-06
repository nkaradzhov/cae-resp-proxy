import type { Context } from "hono";
import type { z } from "zod";
import type ProxyStore from "../proxy-store";
import type { ExtendedProxyConfig, predefinedScenarioParamSchema } from "../util";
import barScenario from "./bar";
import removeSrcAddDestScenario from "./removeSrcAddDest";

type PredefinedScenario = z.infer<typeof predefinedScenarioParamSchema>["scenario"];

export default async function applyPredefinedScenario(
	scenario: PredefinedScenario,
	c: Context,
	proxyStore: ProxyStore,
	config: ExtendedProxyConfig,
) {
	switch (scenario) {
		case "remove-add":
			return await removeSrcAddDestScenario(c, proxyStore, config);

		case "bar":
			return await barScenario(c, proxyStore, config);

		default:
			// This should never happen due to Zod validation, but TypeScript requires it
			return c.json({ success: false, error: "Unknown scenario" }, 400);
	}
}
