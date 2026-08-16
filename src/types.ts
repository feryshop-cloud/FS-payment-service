export const PAYMENT_PROVIDERS = ["mock", "pakasir", "sumopod"] as const;
export type PaymentProviderId = (typeof PAYMENT_PROVIDERS)[number];

export const PAYMENT_STATUSES = ["pending", "paid", "failed", "expired"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const WEBHOOK_EVENTS = ["payment.paid", "payment.failed", "payment.expired"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export interface PaymentRecord {
	id: string;
	order_id: string;
	provider: PaymentProviderId;
	amount: number;
	currency: string;
	description?: string;
	customer?: {
		name?: string;
		email?: string;
		whatsapp?: string;
	};
	// Normalized display fields (isi oleh provider, dipakai FS-Public):
	payment_code: string; // VA number (mock/pakasir VA) atau fallback
	payment_code_display?: string;
	qr_string?: string; // QRIS: isi QR (pakasir qris)
	total_payment?: number; // pakasir: amount + fee
	fee?: number;
	payment_method?: string; // pakasir: "qris" / "bni_va" / ...
	payment_url?: string; // redirect/hosted page bila ada
	status: PaymentStatus;
	created_at: string;
	expires_at: number;
	paid_at?: string;
	failure_reason?: string;
	callback_url?: string;
	return_url?: string;
	webhook_delivered: boolean;
	webhook_attempts: number;
	last_webhook_at?: string;
	// Provider-specific raw payload (audit/debug):
	provider_data?: Record<string, unknown>;
}

export interface WebhookQueueItem {
	id: string;
	payment_id: string;
	order_id: string;
	event: WebhookEvent;
	callback_url: string;
	attempts: number;
	payload: WebhookPayload;
	queued_at: string;
}

export interface WebhookPayload {
	event: WebhookEvent;
	event_id: string;
	payment_id: string;
	order_id: string;
	status: PaymentStatus;
	amount: number;
	currency: string;
	payment_code: string;
	paid_at?: string;
	failure_reason?: string;
	timestamp: string;
}

export interface CreatePaymentRequest {
	order_id: string;
	amount: number;
	currency?: string;
	description?: string;
	customer?: PaymentRecord["customer"];
	expires_in_seconds?: number;
	callback_url?: string;
	return_url?: string;
}

/** Bentukan response normalize dari provider → disimpan & dikirim ke FS-Public. */
export interface CreatePaymentResponse {
	payment_id: string;
	order_id: string;
	provider: PaymentProviderId;
	status: PaymentStatus;
	amount: number;
	currency: string;
	payment_code: string;
	payment_code_display?: string;
	qr_string?: string;
	total_payment?: number;
	fee?: number;
	payment_method?: string;
	payment_url?: string;
	expires_at: number;
	created_at: string;
	paid_at?: string;
	failure_reason?: string;
}

/** Hasil verifikasi webhook masuk dari provider (pakasir dsb). */
export interface ProviderWebhookResult {
	ok: boolean;
	reason?: string;
	// Bila ok, field ini dipakai untuk update record lokal:
	order_id?: string;
	status?: PaymentStatus;
	paid_at?: string;
	failure_reason?: string;
	provider_data?: Record<string, unknown>;
}

export interface WorkerEnv {
	PAYMENTS: KVNamespace;
	WEBHOOK_DELIVERY_QUEUE?: Queue;
	WEBHOOK_DELIVERY_DLQ?: Queue;
	// Provider aktif: "mock" | "pakasir" | "sumopod"
	PAYMENT_PROVIDER?: string;
	// Secret webhook (FS-Public side) — kompat mundur dengan nama lama.
	PAYMENT_WEBHOOK_SECRET?: string;
	MOCK_PAYMENT_WEBHOOK_SECRET?: string;
	DEFAULT_EXPIRES_IN_SECONDS?: string;
	MAX_WEBHOOK_ATTEMPTS?: string;
	ALLOWED_ORIGINS?: string;
	// Set "true" untuk mengizinkan callback_url menuju localhost/private (dev). Default: diblokir (SSRF guard).
	ALLOW_PRIVATE_CALLBACKS?: string;
	// Token admin untuk aksi sandbox (/pay /fail /simulate). Kosong = hanya mock/dev.
	SANDBOX_ADMIN_TOKEN?: string;
	// Pakasir
	PAKASIR_PROJECT?: string;
	PAKASIR_API_KEY?: string;
	PAKASIR_METHOD?: string;
	PAKASIR_SANDBOX?: string;
	PAKASIR_BASE_URL?: string;
	// SumoPod
	SUMODOP_API_KEY?: string;
	SUMODOP_METHOD?: string;
	SUMODOP_SANDBOX?: string;
	SUMODOP_BASE_URL?: string;
	SUMODOP_WEBHOOK_TOKEN?: string;
	SUMODOP_WEBHOOK_SECRET?: string;
}
