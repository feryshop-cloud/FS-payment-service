import type { WorkerEnv, WebhookQueueItem } from "./types";
import { deliverWebhook } from "./webhook";
import { logger } from "./utils/logger";

export async function processWebhookQueue(
	batch: MessageBatch<WebhookQueueItem>,
	env: WorkerEnv,
): Promise<void> {
	for (const msg of batch.messages) {
		try {
			const ok = await deliverWebhook(env, msg.body);
			if (ok) {
				msg.ack();
			} else {
				msg.retry();
			}
		} catch (error) {
			logger.error("queue consumer error", { id: msg.body.id, payment_id: msg.body.payment_id, event: msg.body.event, error });
			msg.retry();
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
