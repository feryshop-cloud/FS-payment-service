import type { WorkerEnv, WebhookQueueItem } from "./types";
import { deliverWebhook } from "./webhook";
import { logger } from "./utils/logger";

const MAX_CONSECUTIVE_FAILURES = 3;

export async function processWebhookQueue(
	batch: MessageBatch<WebhookQueueItem>,
	env: WorkerEnv,
): Promise<void> {
	const consecutiveFailures = new Map<string, number>();

	for (const msg of batch.messages) {
		try {
			const ok = await deliverWebhook(env, msg.body);
			if (ok) {
				msg.ack();
			} else {
				const failures = (consecutiveFailures.get(msg.body.id) || 0) + 1;
				consecutiveFailures.set(msg.body.id, failures);
				if (failures >= MAX_CONSECUTIVE_FAILURES) {
					logger.warn("queue circuit breaker tripped, acking to prevent poison retry", {
						id: msg.body.id,
						payment_id: msg.body.payment_id,
						event: msg.body.event,
						failures,
					});
					msg.ack();
				} else {
					msg.retry();
				}
			}
		} catch (error) {
			const failures = (consecutiveFailures.get(msg.body.id) || 0) + 1;
			consecutiveFailures.set(msg.body.id, failures);
			logger.error("queue consumer error", { id: msg.body.id, payment_id: msg.body.payment_id, event: msg.body.event, error, failures });
			if (failures >= MAX_CONSECUTIVE_FAILURES) {
				logger.warn("queue circuit breaker tripped on exception, acking to prevent poison retry", {
					id: msg.body.id,
					payment_id: msg.body.payment_id,
					event: msg.body.event,
					failures,
				});
				msg.ack();
			} else {
				msg.retry();
			}
		}
	}
}

export async function processDeadLetterQueue(
	batch: MessageBatch<WebhookQueueItem>,
	env: WorkerEnv,
): Promise<void> {
	for (const msg of batch.messages) {
		logger.error("webhook dropped to DLQ", {
			id: msg.body.id,
			payment_id: msg.body.payment_id,
			event: msg.body.event,
			attempts: msg.attempts,
		});
		msg.ack();
	}
}
