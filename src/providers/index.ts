import type {
	CreatePaymentRequest,
	ProviderWebhookResult,
	PaymentProviderId,
	PaymentRecord,
	WorkerEnv,
} from "../types";
import { MockProvider } from "./mock";
import { PakasirProvider } from "./pakasir";

export interface PaymentProvider {
	readonly id: PaymentProviderId;
	isConfigured(env: WorkerEnv): boolean;
	/** Buat payment intent; return PaymentRecord lengkap (belum disimpan) atau null bila gagal. */
	create(env: WorkerEnv, req: CreatePaymentRequest): Promise<PaymentRecord | null>;
	/** Verifikasi webhook masuk dari provider (pakasir; mock tidak menerima webhook). */
	verifyWebhook?(env: WorkerEnv, rawBody: string, headers: Headers): Promise<ProviderWebhookResult>;
	/** Simulasi pembayaran sukses (sandbox). */
	simulate?(env: WorkerEnv, record: PaymentRecord): Promise<PaymentRecord | null>;
	/** Cek status dari provider (reconcile cron). */
	syncStatus?(env: WorkerEnv, record: PaymentRecord): Promise<PaymentRecord | null>;
}

export function normalizeProvider(env: WorkerEnv): PaymentProviderId | null {
	const raw = (env.PAYMENT_PROVIDER || "").trim().toLowerCase();
	if (raw === "mock" || raw === "pakasir") return raw as PaymentProviderId;
	return null;
}

export function getProvider(id: PaymentProviderId): PaymentProvider {
	if (id === "pakasir") return PakasirProvider;
	return MockProvider;
}

export function getActiveProvider(env: WorkerEnv): PaymentProvider | null {
	const id = normalizeProvider(env);
	if (!id) return null;
	const provider = getProvider(id);
	return provider.isConfigured(env) ? provider : null;
}
