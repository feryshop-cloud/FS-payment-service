import type { WorkerEnv, PaymentRecord, WebhookPayload, WebhookQueueItem } from "./types";
import {
	deleteWebhookQueueItem,
	enqueueWebhook,
	listWebhookQueue,
	updateWebhookQueueItem,
} from "./storage";
import { logger } from "./utils/logger";

/**
 * Retrieves the secret key used for signing outgoing webhook requests.
 * Fail-closed: null jika tidak dikonfigurasi (jangan pakai fallback publik).
 */
export function getWebhookSecret(env: WorkerEnv): string | null {
	return env.PAYMENT_WEBHOOK_SECRET || env.MOCK_PAYMENT_WEBHOOK_SECRET || null;
}

function toU8(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

function toHex(buffer: ArrayBuffer): string {
	return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Signs a raw JSON payload string using HMAC SHA-256 with the shared webhook secret.
 *
 * @param env - Cloudflare Worker environment bindings.
 * @param body - Serialized raw request body string.
 * @returns Promise resolving to hex-encoded signature string.
 */
export async function signPayload(env: WorkerEnv, body: string): Promise<string> {
	const secret = getWebhookSecret(env);
	if (!secret) throw new Error("PAYMENT_WEBHOOK_SECRET tidak dikonfigurasi");
	const key = await crypto.subtle.importKey(
		"raw",
		toU8(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, toU8(body));
	return toHex(sig);
}

export function buildPayload(record: PaymentRecord): WebhookPayload {
	const event =
		record.status === "paid"
			? "payment.paid"
			: record.status === "failed"
				? "payment.failed"
				: record.status === "expired"
					? "payment.expired"
					: null;

	if (!event) throw new Error(`No webhook event for status ${record.status}`);
	if (!record.callback_url) throw new Error("Payment has no callback_url");

	return {
		event,
		event_id: `evt_${record.id}_${record.status}_${Date.now().toString(36)}`,
		payment_id: record.id,
		order_id: record.order_id,
		status: record.status,
		amount: record.amount,
		currency: record.currency,
		payment_code: record.payment_code,
		paid_at: record.paid_at,
		failure_reason: record.failure_reason,
		timestamp: new Date().toISOString(),
	};
}

export async function queueWebhook(env: WorkerEnv, record: PaymentRecord): Promise<void> {
	const payload = buildPayload(record);
	if (!record.callback_url) throw new Error("Payment has no callback_url");
	const item: Omit<WebhookQueueItem, "attempts"> = {
		id: `wh_${record.id}_${payload.event_id}`,
		payment_id: record.id,
		order_id: record.order_id,
		event: payload.event,
		callback_url: record.callback_url,
		payload,
		queued_at: new Date().toISOString(),
	};

	await enqueueWebhook(env, item);

	if (env.WEBHOOK_DELIVERY_QUEUE) {
		await env.WEBHOOK_DELIVERY_QUEUE.send(item);
		logger.debug("webhook sent to queue", { payment_id: record.id, event: payload.event });
	}
}

export async function deliverWebhook(env: WorkerEnv, item: WebhookQueueItem): Promise<boolean> {
	if (!getWebhookSecret(env)) {
		logger.error("webhook delivery skipped: PAYMENT_WEBHOOK_SECRET tidak dikonfigurasi", {
			id: item.id,
		});
		return false;
	}
	const body = JSON.stringify(item.payload);
	const signature = await signPayload(env, body);

	try {
		const res = await fetch(item.callback_url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-mock-signature": signature,
				"x-mock-event": item.event,
				"x-mock-idempotency": item.payload.event_id,
				"User-Agent": "payment-service/1.0",
			},
			body,
		});
		const ok = res.status >= 200 && res.status < 300;
		if (ok) {
			logger.info("webhook delivered", { id: item.id, payment_id: item.payment_id, event: item.event, status: res.status });
		} else {
			logger.warn("webhook delivery failed", { id: item.id, payment_id: item.payment_id, event: item.event, status: res.status });
		}
		return ok;
	} catch (error) {
		logger.warn("webhook delivery error", { id: item.id, payment_id: item.payment_id, event: item.event, error });
		return false;
	}
}

export async function retryPendingWebhooks(
	env: WorkerEnv,
): Promise<{ delivered: number; skipped: number }> {
	const items = await listWebhookQueue(env);
	let delivered = 0;
	let skipped = 0;
	const maxAttempts = Math.max(1, Number(env.MAX_WEBHOOK_ATTEMPTS || 5));

	logger.info("webhook retry started", { queueSize: items.length, maxAttempts });

	for (const item of items) {
		const ok = await deliverWebhook(env, item);
		if (ok) {
			await deleteWebhookQueueItem(env, item.id);
			delivered++;
		} else {
			item.attempts += 1;
			if (item.attempts >= maxAttempts) {
				await deleteWebhookQueueItem(env, item.id);
				logger.warn("webhook dropped after max attempts", {
					maxAttempts,
					id: item.id,
					payment_id: item.payment_id,
					event: item.event,
				});
			} else {
				await updateWebhookQueueItem(env, item);
			}
			skipped++;
		}
	}
	logger.info("webhook retry completed", { delivered, skipped });
	return { delivered, skipped };
}

export async function deliverNow(
	env: WorkerEnv,
	record: PaymentRecord,
	ctx: ExecutionContext,
): Promise<void> {
	await queueWebhook(env, record);
	ctx.waitUntil(
		(async () => {
			const queued = await listWebhookQueue(env);
			for (const q of queued) {
				if (q.payment_id === record.id) {
					const ok = await deliverWebhook(env, q);
					if (ok) await deleteWebhookQueueItem(env, q.id);
					else await updateWebhookQueueItem(env, { ...q, attempts: q.attempts + 1 });
				}
			}
		})(),
	);
}
