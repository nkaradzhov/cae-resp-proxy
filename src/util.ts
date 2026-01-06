import type { ProxyConfig } from "redis-monorepo/packages/test-utils/lib/proxy/redis-proxy.ts";
import { z } from "zod";

// Extended ProxyConfig that supports multiple listen ports
export type ExtendedProxyConfig = Omit<ProxyConfig, "listenPort"> & {
	listenPort: number[];
	readonly apiPort?: number;
	defaultInterceptors?: string;
};

export const encodingSchema = z.object({
	encoding: z.enum(["base64", "raw"]).default("base64"),
});

export const paramSchema = z.object({
	connectionId: z.string(),
});

export const connectionIdsQuerySchema = z.object({
	connectionIds: z
		.string()
		.transform((val) => val.split(","))
		.pipe(z.array(z.string()).min(1, "At least one connection ID is required")),
	encoding: z.enum(["base64", "raw"]).default("base64"),
});

export const scenarioSchema = z.object({
	responses: z.array(z.string()).min(1, "At least one response is required"),
	encoding: z.enum(["base64", "raw"]).default("base64"),
});

export const interceptorSchema = z.object({
	name: z.string(),
	encoding: z.enum(["raw", "base64"]),
	match: z.string(),
	response: z.string(),
});

export const predefinedScenarioParamSchema = z.object({
	scenario: z.enum(["remove-add", "bar"]),
});

export function parseBuffer(data: string, encoding: "base64" | "raw"): Buffer {
	switch (encoding) {
		case "base64":
			return Buffer.from(data, "base64");
		case "raw":
			return Buffer.from(data, "binary");
		default:
			throw new Error(`Unsupported encoding: ${encoding}`);
	}
}

export const DEFAULT_LISTEN_PORT = [6379];
export const DEFAULT_LISTEN_HOST = "127.0.0.1";
export const DEFAULT_ENABLE_LOGGING = false;
export const DEFAULT_API_PORT = 3000;

const listenPortSchema = z
	.preprocess((value) => {
		if (Array.isArray(value)) return value;
		if (typeof value === "string") return value.split(",");
		return [value];
	}, z.array(z.coerce.number()).min(1))
	.default(DEFAULT_LISTEN_PORT);

export const proxyConfigSchema = z.object({
	listenPort: listenPortSchema,
	listenHost: z.string().optional().default(DEFAULT_LISTEN_HOST),
	targetHost: z.string(),
	targetPort: z.coerce.number(),
	timeout: z.coerce.number().optional(),
	enableLogging: z.boolean().optional().default(DEFAULT_ENABLE_LOGGING),
	apiPort: z.number().optional().default(DEFAULT_API_PORT),
	defaultInterceptors: z.string().optional(),
});

const envSchema = z.object({
	LISTEN_PORT: listenPortSchema,
	TARGET_HOST: z.string(),
	TARGET_PORT: z.coerce.number(),
	LISTEN_HOST: z.string().optional(),
	TIMEOUT: z.coerce.number().optional(),
	ENABLE_LOGGING: z
		.enum(["true", "false"])
		.transform((val) => val === "true")
		.optional(),
	API_PORT: z.coerce.number().optional().default(DEFAULT_API_PORT),
	DEFAULT_INTERCEPTORS: z.string().optional(),
});

export function parseCliArgs(argv: string[]): Record<string, string | boolean | number | number[]> {
	const args: Record<string, string | boolean | number | number[]> = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg?.startsWith("--")) {
			const [key, value] = arg.slice(2).split("=");
			if (key !== undefined && value !== undefined) {
				args[key] = parseValue(value);
			} else if (key !== undefined) {
				const nextArg = argv[i + 1];
				if (nextArg && !nextArg.startsWith("--")) {
					args[key] = parseValue(nextArg);
					i++;
				} else {
					args[key] = true;
				}
			}
		}
	}
	return args;
}

function parseValue(value: string): boolean | number | string | number[] {
	if (value === "true") return true;
	if (value === "false") return false;
	if (value.includes(",")) {
		const parts = value.split(",").map((v) => Number(v.trim()));
		if (parts.every((n) => !Number.isNaN(n))) return parts;
	}
	const num = Number(value);
	if (!Number.isNaN(num)) return num;
	return value;
}

export function printUsage() {
	console.log(`
Usage: bun run proxy [options]

Required options:
  --listenPort <number|number[]>  Port(s) to listen on (comma-separated for multiple)
  --targetHost <string>           Target host to forward to
  --targetPort <number>           Target port to forward to

Optional options:
  --listenHost <string>     Host to listen on (default: 127.0.0.1)
  --timeout <number>        Connection timeout in milliseconds
  --enableLogging           Enable verbose logging
  --apiPort                 Port to start the http on (default: 3000 )
  --defaultInterceptors     Comma-separated list of default interceptors to load ( like cluster, hitless, etc. )

Or configure using environment variables:
  LISTEN_PORT, TARGET_HOST, TARGET_PORT (required)
  LISTEN_HOST, TIMEOUT, ENABLE_LOGGING, API_PORT, DEFAULT_INTERCEPTORS (optional)

Examples:
  bun run proxy --listenPort=6379 --targetHost=localhost --targetPort=6380
  bun run proxy --listenPort=6379,6380,6381 --defaultInterceptors=cluster --targetHost=localhost --targetPort=6382
  docker run -p 3000:3000 -p 6379:6379  -e LISTEN_PORT=6379 -e TARGET_HOST=host.docker.internal -e TARGET_PORT=6380 your-image-name
  `);
}

export function getConfig(): ExtendedProxyConfig {
	const cliArgs = parseCliArgs(Bun.argv.slice(2));

	let configSource: Record<string, string | number | boolean | number[] | undefined>;

	if (Object.keys(cliArgs).length > 0) {
		console.log("Using configuration from command-line arguments.");
		configSource = cliArgs;
	} else {
		console.log("Using configuration from environment variables.");
		const parsedEnv = envSchema.parse(process.env);
		configSource = {
			listenPort: parsedEnv.LISTEN_PORT,
			listenHost: parsedEnv.LISTEN_HOST,
			targetHost: parsedEnv.TARGET_HOST,
			targetPort: parsedEnv.TARGET_PORT,
			timeout: parsedEnv.TIMEOUT,
			enableLogging: parsedEnv.ENABLE_LOGGING,
			apiPort: parsedEnv.API_PORT,
			defaultInterceptors: parsedEnv.DEFAULT_INTERCEPTORS,
		};
	}

	return proxyConfigSchema.parse(configSource);
}
