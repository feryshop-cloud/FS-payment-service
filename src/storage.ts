import type { WorkerEnv, PaymentRecord, WebhookQueueItem } from "./types";

const PAYMENT_KEY = (id: string) => `payment:${id}`;
const PAYMENT_BY_ORDER = (orderId: string) => `order:${orderId}`;
const WEBHOOK_QUEUE_KEY = (id: string) => `webhook:${id}`;

export function newId(prefix: string): string {
	const rand = crypto.getRandomValues(new Uint8Array(8));
	let hex = "";
	for (const b of rand) hex += b.toString(16).padStart(2, "0");
	return `${prefix}_${hex}`;
}

export function generateVirtualAccount(): string {
	const rand = crypto.getRandomValues(new Uint8Array(10));
	let digits = "";
	for (const b of rand) digits += (b % 10).toString();
	return `880${digits.slice(0, 13)}`;
}

export async function getPayment(env: WorkerEnv, id: string): Promise<PaymentRecord | null> {
	const raw = await env.PAYMENTS.get(PAYMENT_KEY(id));
	if (!raw) return null;
	return JSON.parse(raw) as PaymentRecord;
}

export async function putPayment(env: WorkerEnv, record: PaymentRecord): Promise<void> {
	await env.PAYMENTS.put(PAYMENT_KEY(record.id), JSON.stringify(record));
	await env.PAYMENTS.put(PAYMENT_BY_ORDER(record.order_id), record.id);
}

export async function getPaymentByOrder(
	env: WorkerEnv,
	orderId: string,
): Promise<PaymentRecord | null> {
	const paymentId = await env.PAYMENTS.get(PAYMENT_BY_ORDER(orderId));
	if (!paymentId) return null;
	return getPayment(env, paymentId);
}

export async function listPayments(env: WorkerEnv): Promise<PaymentRecord[]> {
	const out: PaymentRecord[] = [];
	let cursor: string | null = null;
	do {
		const page: KVNamespaceListResult<unknown> = await env.PAYMENTS.list({
			prefix: "payment:",
			cursor: cursor ?? undefined,
		});
		for (const key of page.keys) {
			const raw = await env.PAYMENTS.get(key.name);
			if (raw) out.push(JSON.parse(raw) as PaymentRecord);
		}
		cursor = page.list_complete === false ? page.cursor : null;
	} while (cursor);
	return out;
}

export async function enqueueWebhook(
	env: WorkerEnv,
	item: Omit<WebhookQueueItem, "attempts"> & { attempts?: number },
): Promise<void> {
	const full: WebhookQueueItem = { attempts: 0, ...item };
	await env.PAYMENTS.put(WEBHOOK_QUEUE_KEY(full.id), JSON.stringify(full));
}

export async function getWebhookQueueItem(
	env: WorkerEnv,
	id: string,
): Promise<WebhookQueueItem | null> {
	const raw = await env.PAYMENTS.get(WEBHOOK_QUEUE_KEY(id));
	if (!raw) return null;
	return JSON.parse(raw) as WebhookQueueItem;
}

export async function updateWebhookQueueItem(
	env: WorkerEnv,
	item: WebhookQueueItem,
): Promise<void> {
	await env.PAYMENTS.put(WEBHOOK_QUEUE_KEY(item.id), JSON.stringify(item));
}

export async function listWebhookQueue(env: WorkerEnv): Promise<WebhookQueueItem[]> {
	const out: WebhookQueueItem[] = [];
	let cursor: string | null = null;
	do {
		const page: KVNamespaceListResult<unknown> = await env.PAYMENTS.list({
			prefix: "webhook:",
			cursor: cursor ?? undefined,
		});
		for (const key of page.keys) {
			const raw = await env.PAYMENTS.get(key.name);
			if (raw) out.push(JSON.parse(raw) as WebhookQueueItem);
		}
		cursor = page.list_complete === false ? page.cursor : null;
	} while (cursor);
	return out;
}

export async function deleteWebhookQueueItem(env: WorkerEnv, id: string): Promise<void> {
	await env.PAYMENTS.delete(WEBHOOK_QUEUE_KEY(id));
}
