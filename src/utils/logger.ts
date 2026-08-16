import { resolveLogLevel, isLevelEnabled, serializeError, type LogLevel } from "./format";

const SERVICE = "payment-service";

let currentRequestId: string | undefined;

export function setRequestId(requestId: string | undefined): void {
	currentRequestId = requestId;
}

export function getRequestId(): string | undefined {
	return currentRequestId;
}

function write(
	level: LogLevel,
	message: string,
	meta?: Record<string, unknown>,
): void {
	const configured = resolveLogLevel();
	if (!isLevelEnabled(configured, level)) return;

	const nodeEnv =
		typeof process !== "undefined" && process.env?.NODE_ENV && process.env.NODE_ENV !== "undefined"
			? process.env.NODE_ENV
			: "production";

	const payload: Record<string, unknown> = {
		level: level === "debug" ? 20 : level === "info" ? 30 : level === "warn" ? 40 : 50,
		time: Date.now(),
		service: SERVICE,
		environment: nodeEnv,
		msg: message,
	};

	if (currentRequestId) payload.requestId = currentRequestId;

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
	serializeError,
};
