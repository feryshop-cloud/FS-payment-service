export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_RANK: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

export function resolveLogLevel(): LogLevel {
	const envValue =
		typeof process !== "undefined" && process.env && process.env.LOG_LEVEL
			? process.env.LOG_LEVEL
			: "";
	const fromEnv = envValue.toLowerCase();
	if (fromEnv in LOG_LEVEL_RANK) return fromEnv as LogLevel;
	return "info";
}

export function isLevelEnabled(configured: LogLevel, candidate: LogLevel): boolean {
	return LOG_LEVEL_RANK[candidate] >= LOG_LEVEL_RANK[configured];
}

/**
 * Serialize an error into structured shape: `{ type, message, stack }`.
 * Plain objects / primitives pass through untouched.
 */
export function serializeError(error: unknown): unknown {
	if (error instanceof Error) {
		const result: Record<string, unknown> = {
			type: error.name || "Error",
			message: error.message,
		};
		if (error.stack) result.stack = error.stack;
		if ("code" in error) result.code = (error as { code?: unknown }).code;
		if (error.cause !== undefined && error.cause !== null) {
			result.cause = serializeError(error.cause);
		}
		return result;
	}
	if (typeof error === "object" && error !== null) {
		const e = error as { name?: unknown; message?: unknown; stack?: unknown };
		if (e.message !== undefined || e.stack !== undefined) {
			const result: Record<string, unknown> = {
				type: typeof e.name === "string" ? e.name : "Error",
				message: e.message,
			};
			if (e.stack) result.stack = e.stack;
			return result;
		}
	}
	return error;
}
