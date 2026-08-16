import type {
	CreatePaymentRequest,
	PaymentProviderId,
	PaymentRecord,
	ProviderWebhookResult,
	WorkerEnv,
} from "../types";
import type { PaymentProvider } from "./index";
import { logger } from "../utils/logger";

function baseUrl(env: WorkerEnv): string {
	return (
		env.SUMODOP_BASE_URL || "https://api-pay-sandbox.sumopod.com/api/v1"
	).replace(/\/+$/, "");
}

function method(env: WorkerEnv): string {
	const m = (env.SUMODOP_METHOD || "QRIS").trim().toUpperCase();
	return m || "QRIS";
}

function parseExpiry(value: string | undefined): number {
	if (!value) return Math.floor(Date.now() / 1000) + 24 * 3600;
	const t = new Date(value).getTime();
	if (Number.isNaN(t)) return Math.floor(Date.now() / 1000) + 24 * 3600;
	return Math.floor(t / 1000);
}

function expiresInHours(req: CreatePaymentRequest): number | undefined {
	if (typeof req.expires_in_seconds !== "number" || !Number.isFinite(req.expires_in_seconds)) {
		return undefined;
	}
	const hours = Math.ceil(req.expires_in_seconds / 3600);
	return Math.min(24, Math.max(1, hours));
}

async function callApi<T>(
	env: WorkerEnv,
	path: string,
	body: Record<string, unknown>,
): Promise<{ status: number; json: T | null }> {
	const apiKey = env.SUMODOP_API_KEY;
	const res = await fetch(`${baseUrl(env)}${path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(apiKey ? { "X-Api-Key": apiKey } : {}),
		},
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		logger.error("sumopod api error", { path, status: res.status });
		return { status: res.status, json: null };
	}
	const json = (await res.json().catch(() => null)) as T | null;
	return { status: res.status, json };
}

function bytesToBase64(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
}

async function verifySvix(secret: string, headers: Headers, rawBody: string): Promise<boolean> {
	const svixId = headers.get("svix-id");
	const svixTimestamp = headers.get("svix-timestamp");
	const svixSignature = headers.get("svix-signature");
	if (!svixId || !svixTimestamp || !svixSignature) return false;

	const ts = Number(svixTimestamp);
	if (!Number.isFinite(ts)) return false;
	if (Math.abs(Date.now() / 1000 - ts) > 300) return false;

	const secretBytes = Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (c) =>
		c.charCodeAt(0),
	);
	const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
	const key = await crypto.subtle.importKey(
		"raw",
		secretBytes,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedContent));
	const expected = bytesToBase64(new Uint8Array(sig));

	const signatures = svixSignature.split(" ").map((s) => s.split(",")[1]);
	return signatures.includes(expected);
}

async function verifySignature(
	env: WorkerEnv,
	headers: Headers,
	rawBody: string,
): Promise<{ ok: boolean; reason?: string }> {
	const token = env.SUMODOP_WEBHOOK_TOKEN;
	if (token) {
		const received = headers.get("x-webhook-token");
		if (!received || received !== token) return { ok: false, reason: "invalid webhook token" };
		return { ok: true };
	}
	const secret = env.SUMODOP_WEBHOOK_SECRET;
	if (secret) {
		const ok = await verifySvix(secret, headers, rawBody);
		return ok ? { ok: true } : { ok: false, reason: "invalid svix signature" };
	}
	return { ok: false, reason: "sumopod webhook verification not configured" };
}

export const SumodopProvider: PaymentProvider = {
	id: "sumopod" as PaymentProviderId,

	isConfigured(env: WorkerEnv): boolean {
		return Boolean(env.SUMODOP_API_KEY);
	},

	async create(env: WorkerEnv, req: CreatePaymentRequest): Promise<PaymentRecord | null> {
		const apiKey = env.SUMODOP_API_KEY;
		if (!apiKey) return null;

		const m = method(env);
		const { json } = await callApi<{
			payment_id?: string;
			order_id?: string;
			amount?: number;
			fee?: number;
			net_amount?: number;
			payment_link_url?: string;
			status?: string;
			expires_at?: string;
		}>(env, "/payments", {
			order_id: req.order_id,
			amount: Math.floor(req.amount),
			currency: req.currency || "IDR",
			expires_in_hours: expiresInHours(req),
			success_return_url: req.return_url || undefined,
			payment_method_type_code: m,
		});

		const p = json;
		if (!p || !p.payment_id) {
			logger.error("sumopod create missing payment_id", { order_id: req.order_id });
			return null;
		}

		const amount = p.amount ?? Math.floor(req.amount);
		const record: PaymentRecord = {
			id: `sm_${p.payment_id.replace(/[^a-zA-Z0-9_-]/g, "")}`,
			order_id: req.order_id,
			provider: "sumopod",
			amount,
			currency: req.currency || "IDR",
			description: req.description,
			customer: req.customer,
			// Hosted page SumoPod, bukan VA/QR string → payment_code kosong.
			payment_code: "",
			payment_code_display: m,
			total_payment: amount, // customer bayar sesuai amount; fee dipotong ke merchant.
			fee: p.fee,
			payment_method: m.toLowerCase(),
			payment_url: p.payment_link_url,
			status: "pending",
			created_at: new Date().toISOString(),
			expires_at: parseExpiry(p.expires_at),
			callback_url: req.callback_url,
			return_url: req.return_url,
			webhook_delivered: false,
			webhook_attempts: 0,
			provider_data: { ...p },
		};

		return record;
	},

	async verifyWebhook(env: WorkerEnv, rawBody: string, headers: Headers): Promise<ProviderWebhookResult> {
		if (!env.SUMODOP_API_KEY) {
			return { ok: false, reason: "sumopod not configured" };
		}

		const verified = await verifySignature(env, headers, rawBody);
		if (!verified.ok) {
			return { ok: false, reason: verified.reason };
		}

		let body: { event_type?: string; data?: Record<string, unknown> } = {};
		try {
			body = JSON.parse(rawBody) as typeof body;
		} catch {
			return { ok: false, reason: "invalid json" };
		}

		const data = body.data && typeof body.data === "object" ? body.data : {};
		const orderId = typeof data.order_id === "string" ? data.order_id : "";
		if (!orderId) {
			return { ok: false, reason: "missing order_id" };
		}

		const statusMap: Record<string, "paid" | "failed" | "expired"> = {
			"payment.completed": "paid",
			"payment.failed": "failed",
			"payment.expired": "expired",
		};
		const status = statusMap[body.event_type || ""];
		if (!status) {
			// Event tak dikenal (mis. payment.test) → ack tanpa apply.
			return {
				ok: true,
				order_id: orderId,
				status: "pending",
				provider_data: { event_type: body.event_type, ...data },
			};
		}

		return {
			ok: true,
			order_id: orderId,
			status,
			paid_at: status === "paid" ? (data.completed_at as string) : undefined,
			failure_reason: status === "failed" ? "Pembayaran gagal di gateway" : undefined,
			provider_data: { event_type: body.event_type, ...data },
		};
	},
};