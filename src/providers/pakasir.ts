import type {
	CreatePaymentRequest,
	PaymentProviderId,
	PaymentRecord,
	ProviderWebhookResult,
	WorkerEnv,
} from "../types";
import type { PaymentProvider } from "./index";

function baseUrl(env: WorkerEnv): string {
	return (env.PAKASIR_BASE_URL || "https://app.pakasir.com").replace(/\/+$/, "");
}

function method(env: WorkerEnv): string {
	const m = (env.PAKASIR_METHOD || "qris").trim().toLowerCase();
	return m || "qris";
}

function isSandbox(env: WorkerEnv): boolean {
	return env.PAKASIR_SANDBOX === "1" || env.PAKASIR_SANDBOX === "true";
}

function parseExpiry(value: string | undefined): number {
	if (!value) return Math.floor(Date.now() / 1000) + 300;
	const t = new Date(value).getTime();
	if (Number.isNaN(t)) return Math.floor(Date.now() / 1000) + 300;
	return Math.floor(t / 1000);
}

async function callApi<T>(
	env: WorkerEnv,
	path: string,
	body: Record<string, unknown>,
): Promise<T | null> {
	const res = await fetch(`${baseUrl(env)}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		console.error("pakasir api error", { path, status: res.status });
		return null;
	}
	const json = (await res.json().catch(() => null)) as T | null;
	return json;
}

export const PakasirProvider: PaymentProvider = {
	id: "pakasir" as PaymentProviderId,

	isConfigured(env: WorkerEnv): boolean {
		return Boolean(env.PAKASIR_PROJECT && env.PAKASIR_API_KEY);
	},

	async create(env: WorkerEnv, req: CreatePaymentRequest): Promise<PaymentRecord | null> {
		const project = env.PAKASIR_PROJECT;
		const apiKey = env.PAKASIR_API_KEY;
		if (!project || !apiKey) return null;

		const amount = Math.floor(req.amount);
		const m = method(env);
		const apiPath = `/api/transactioncreate/${m}`;

		const json = await callApi<{
			payment?: {
				project?: string;
				order_id?: string;
				amount?: number;
				fee?: number;
				total_payment?: number;
				payment_method?: string;
				payment_number?: string;
				expired_at?: string;
			};
		}>(env, apiPath, {
			project,
			order_id: req.order_id,
			amount,
			api_key: apiKey,
		});

		const p = json?.payment;
		if (!p || !p.payment_number) {
			console.error("pakasir create missing payment_number", { order_id: req.order_id });
			return null;
		}

		const isQris = (p.payment_method || m) === "qris";
		const payment_code = p.payment_number;
		const record: PaymentRecord = {
			id: `pk_${req.order_id.replace(/[^a-zA-Z0-9_-]/g, "")}`,
			order_id: req.order_id,
			provider: "pakasir",
			amount,
			currency: "IDR",
			description: req.description,
			customer: req.customer,
			payment_code: isQris ? "" : payment_code, // QRIS pakai qr_string
			payment_code_display: isQris ? "QRIS" : payment_code,
			qr_string: isQris ? payment_code : undefined,
			total_payment: p.total_payment ?? amount,
			fee: p.fee,
			payment_method: p.payment_method || m,
			status: "pending",
			created_at: new Date().toISOString(),
			expires_at: parseExpiry(p.expired_at),
			callback_url: req.callback_url,
			return_url: req.return_url,
			webhook_delivered: false,
			webhook_attempts: 0,
			provider_data: { ...p },
		};

		return record;
	},

	async verifyWebhook(env: WorkerEnv, rawBody: string): Promise<ProviderWebhookResult> {
		if (!env.PAKASIR_PROJECT || !env.PAKASIR_API_KEY) {
			return { ok: false, reason: "pakasir not configured" };
		}

		let body: {
			order_id?: string;
			amount?: number;
			project?: string;
			status?: string;
			payment_method?: string;
			completed_at?: string;
		} = {};
		try {
			body = JSON.parse(rawBody) as typeof body;
		} catch {
			return { ok: false, reason: "invalid json" };
		}

		const orderId = body.order_id;
		const amount = body.amount;
		if (!orderId || typeof amount !== "number") {
			return { ok: false, reason: "missing order_id or amount" };
		}

		// Cross-check dengan transactiondetail (rekomendasi docs — webhook tanpa signature).
		const project = env.PAKASIR_PROJECT;
		const apiKey = env.PAKASIR_API_KEY;
		const url = `${baseUrl(env)}/api/transactiondetail?project=${encodeURIComponent(
			project,
		)}&amount=${amount}&order_id=${encodeURIComponent(orderId)}&api_key=${encodeURIComponent(apiKey)}`;

		const res = await fetch(url, { method: "GET" });
		if (!res.ok) {
			return { ok: false, reason: `transactiondetail http ${res.status}` };
		}
		const json = (await res.json().catch(() => null)) as {
			transaction?: {
				status?: string;
				order_id?: string;
				amount?: number;
				payment_method?: string;
				completed_at?: string;
			};
		} | null;
		const tx = json?.transaction;

		if (!tx || tx.order_id !== orderId || Number(tx.amount) !== amount) {
			return { ok: false, reason: "transactiondetail mismatch" };
		}

		if (tx.status !== "completed") {
			// Status belum final → terima tapi tanpa apply (biar webhook dianggap deliver).
			return {
				ok: true,
				order_id: orderId,
				status: "pending",
				provider_data: { ...tx },
			};
		}

		return {
			ok: true,
			order_id: orderId,
			status: "paid",
			paid_at: tx.completed_at,
			provider_data: { ...tx },
		};
	},

	async simulate(env: WorkerEnv, record: PaymentRecord): Promise<PaymentRecord | null> {
		if (!isSandbox(env)) return null;
		const project = env.PAKASIR_PROJECT;
		const apiKey = env.PAKASIR_API_KEY;
		if (!project || !apiKey) return null;

		const json = await callApi<{ success?: boolean }>(env, "/api/paymentsimulation", {
			project,
			order_id: record.order_id,
			amount: record.amount,
			api_key: apiKey,
		});
		if (!json) return null;

		record.status = "paid";
		record.paid_at = new Date().toISOString();
		return record;
	},

	async syncStatus(env: WorkerEnv, record: PaymentRecord): Promise<PaymentRecord | null> {
		if (!env.PAKASIR_PROJECT || !env.PAKASIR_API_KEY) return null;
		const url = `${baseUrl(env)}/api/transactiondetail?project=${encodeURIComponent(
			env.PAKASIR_PROJECT,
		)}&amount=${record.amount}&order_id=${encodeURIComponent(record.order_id)}&api_key=${encodeURIComponent(
			env.PAKASIR_API_KEY,
		)}`;

		const res = await fetch(url, { method: "GET" });
		if (!res.ok) return null;
		const json = (await res.json().catch(() => null)) as {
			transaction?: { status?: string; completed_at?: string };
		} | null;
		const status = json?.transaction?.status;
		if (status === "completed") {
			record.status = "paid";
			record.paid_at = json?.transaction?.completed_at;
			return record;
		}
		return null;
	},
};
