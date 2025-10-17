import type { ProxyConfig } from "redis-monorepo/packages/test-utils/lib/redis-proxy.ts";
import { z } from "zod";

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

export const DEFAULT_LISTEN_PORT = 6379;
export const DEFAULT_LISTEN_HOST = "127.0.0.1";
export const DEFAULT_ENABLE_LOGGING = false;
export const DEFAULT_API_PORT = 3000;

export const proxyConfigSchema = z.object({
	listenPort: z.coerce.number().default(DEFAULT_LISTEN_PORT),
	listenHost: z.string().optional().default(DEFAULT_LISTEN_HOST),
	targetHost: z.string(),
	targetPort: z.coerce.number(),
	timeout: z.coerce.number().optional(),
	enableLogging: z.boolean().optional().default(DEFAULT_ENABLE_LOGGING),
	apiPort: z.number().optional().default(DEFAULT_API_PORT),
});

const envSchema = z.object({
	LISTEN_PORT: z.coerce.number().default(DEFAULT_LISTEN_PORT),
	TARGET_HOST: z.string(),
	TARGET_PORT: z.coerce.number(),
	LISTEN_HOST: z.string().optional(),
	TIMEOUT: z.coerce.number().optional(),
	ENABLE_LOGGING: z
		.enum(["true", "false"])
		.transform((val) => val === "true")
		.optional(),
	API_PORT: z.coerce.number().optional().default(DEFAULT_API_PORT),
});

export function parseCliArgs(argv: string[]): Record<string, string | boolean | number> {
	const args: Record<string, string | boolean | number> = {};
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

function parseValue(value: string): boolean | number | string {
	if (value === "true") return true;
	if (value === "false") return false;
	const num = Number(value);
	if (!Number.isNaN(num)) return num;
	return value;
}

export function printUsage() {
	console.log(`
Usage: bun run proxy [options]

Required options:
  --listenPort <number>     Port to listen on
  --targetHost <string>     Target host to forward to
  --targetPort <number>     Target port to forward to

Optional options:
  --listenHost <string>     Host to listen on (default: 127.0.0.1)
  --timeout <number>        Connection timeout in milliseconds
  --enableLogging           Enable verbose logging
  --apiPort                 Port to start the http on (default: 3000 )

Or configure using environment variables:
  LISTEN_PORT, TARGET_HOST, TARGET_PORT (required)
  LISTEN_HOST, TIMEOUT, ENABLE_LOGGING, API_PORT (optional)

Examples:
  bun run proxy --listenPort=6379 --targetHost=localhost --targetPort=6380
  docker run -p 3000:3000 -p 6379:6379  -e LISTEN_PORT=6379 -e TARGET_HOST=host.docker.internal -e TARGET_PORT=6380 your-image-name
  `);
}

export function getConfig(): ProxyConfig & { readonly apiPort?: number } {
	const cliArgs = parseCliArgs(Bun.argv.slice(2));

	let configSource: Record<string, string | number | boolean | undefined>;

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
		};
	}

	return proxyConfigSchema.parse(configSource);
}
