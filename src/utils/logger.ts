const LOG_LEVEL_NUM = { debug: 20, info: 30, warn: 40, error: 50 };

function serializeError(error: unknown): unknown {
	if (error instanceof Error) {
		const result: Record<string, unknown> = { type: error.name || "Error", message: error.message };
		if (error.stack) result.stack = error.stack;
		if ("code" in error) result.code = (error as { code?: unknown }).code;
		return result;
	}
	if (typeof error === "object" && error !== null) {
		const e = error as { name?: unknown; message?: unknown; stack?: unknown };
		if (e.message !== undefined || e.stack !== undefined) {
			return { type: typeof e.name === "string" ? e.name : "Error", message: e.message };
		}
	}
	return error;
}

function write(
	level: keyof typeof LOG_LEVEL_NUM,
	message: string,
	meta?: Record<string, unknown>,
): void {
	const nodeEnv =
		typeof process !== "undefined" && process.env?.NODE_ENV && process.env.NODE_ENV !== "undefined"
			? process.env.NODE_ENV
			: "production";
	const payload: Record<string, unknown> = {
		level: LOG_LEVEL_NUM[level],
		time: Date.now(),
		service: "payment-service",
		environment: nodeEnv,
		msg: message,
	};
	if (meta && Object.keys(meta).length > 0) {
		for (const [key, value] of Object.entries(meta)) {
			if (key === "error" || key === "err") payload.err = serializeError(value);
			else payload[key] = value instanceof Error ? serializeError(value) : value;
		}
	}
	const line = JSON.stringify(payload);
	if (level === "error" || level === "warn") console.error(line);
	else console.log(line);
}

export const logger = {
	debug: (message: string, meta?: Record<string, unknown>) => write("debug", message, meta),
	info: (message: string, meta?: Record<string, unknown>) => write("info", message, meta),
	warn: (message: string, meta?: Record<string, unknown>) => write("warn", message, meta),
	error: (message: string, meta?: Record<string, unknown>) => write("error", message, meta),
};
