import type { CreatePaymentRequest, PaymentProviderId, PaymentRecord, WorkerEnv } from "../types";
import type { PaymentProvider } from "./index";
import { generateVirtualAccount, newId } from "../storage";

function clampExpiry(requested: number | undefined, fallback: number): number {
	if (typeof requested === "number" && Number.isFinite(requested) && requested > 0) {
		return Math.floor(requested);
	}
	return Math.floor(fallback);
}

export const MockProvider: PaymentProvider = {
	id: "mock" as PaymentProviderId,

	isConfigured(): boolean {
		return true;
	},

	async create(env: WorkerEnv, body: CreatePaymentRequest): Promise<PaymentRecord | null> {
		const now = Date.now();
		const defaultExpiry = Number(env.DEFAULT_EXPIRES_IN_SECONDS || 300);
		const id = newId("pay");
		const payment_code = generateVirtualAccount();

		const record: PaymentRecord = {
			id,
			order_id: body.order_id,
			provider: "mock",
			amount: Math.floor(body.amount),
			currency: body.currency || "IDR",
			description: body.description,
			customer: body.customer,
			payment_code,
			payment_code_display: `Virtual Account ${payment_code}`,
			status: "pending",
			created_at: new Date(now).toISOString(),
			expires_at: Math.floor(now / 1000) + clampExpiry(body.expires_in_seconds, defaultExpiry),
			callback_url: body.callback_url,
			return_url: body.return_url,
			webhook_delivered: false,
			webhook_attempts: 0,
		};

		return record;
	},

	async simulate(): Promise<PaymentRecord | null> {
		return null;
	},
};
