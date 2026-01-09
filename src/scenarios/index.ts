import type { Context } from "hono";
import type { z } from "zod";
import type ProxyStore from "../proxy-store";
import type {
  ExtendedProxyConfig,
  predefinedScenarioParamSchema,
} from "../util";
import addNodeScenario from "./add";
import removeSrcAddDestScenario from "./remove-add";
import removeNodeScenario from "./remove";
import slotShuffleScenario from "./slot-shuffle";

type PredefinedScenario = z.infer<
  typeof predefinedScenarioParamSchema
>["scenario"];

export default async function applyPredefinedScenario(
  scenario: PredefinedScenario,
  c: Context,
  proxyStore: ProxyStore,
  config: ExtendedProxyConfig,
) {
  switch (scenario) {
    case "remove-add":
      return await removeSrcAddDestScenario(c, proxyStore, config);
    case "add":
      return await addNodeScenario(c, proxyStore, config);
    case "remove":
      return await removeNodeScenario(c, proxyStore, config);
    case "slot-shuffle":
      return await slotShuffleScenario(c, proxyStore, config);

    default:
      // This should never happen due to Zod validation, but TypeScript requires it
      return c.json({ success: false, error: "Unknown scenario" }, 400);
  }
}
