import type {
	CreatePaymentRequest,
	CreatePaymentResponse,
	PaymentRecord,
	PaymentProviderId,
	WorkerEnv,
} from "./types";
import { getPayment, getPaymentByOrder, listPayments, putPayment } from "./storage";
import { deliverNow, deliverWebhook, queueWebhook, retryPendingWebhooks } from "./webhook";
import { renderPayPage } from "./pay-page";
import { getActiveProvider, getProvider, normalizeProvider } from "./providers";

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json",
			...headers,
		},
	});

const corsHeaders = (env: WorkerEnv): Record<string, string> => {
	const allowed = (env.ALLOWED_ORIGINS || "*")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return {
		"Access-Control-Allow-Origin": allowed.includes("*") ? "*" : allowed.join(", ") || "*",
		"Access-Control-Allow-Methods": "GET,POST,OPTIONS,PATCH",
		"Access-Control-Allow-Headers":
			"Content-Type, Authorization, x-payment-signature, x-mock-signature, x-payment-event, x-payment-idempotency",
		"Access-Control-Max-Age": "86400",
	};
};

function getOrigin(req: Request): string {
	const url = new URL(req.url);
	return url.origin;
}

function toResponse(record: PaymentRecord, origin: string): CreatePaymentResponse {
	const isMock = record.provider === "mock";
	return {
		payment_id: record.id,
		order_id: record.order_id,
		provider: record.provider,
		status: record.status,
		amount: record.amount,
		currency: record.currency,
		payment_code: record.payment_code,
		payment_code_display: record.payment_code_display,
		qr_string: record.qr_string,
		total_payment: record.total_payment,
		fee: record.fee,
		payment_method: record.payment_method,
		// Mock: halaman simulasi di worker sendiri. Pakasir API mode: tanpa hosted page.
		payment_url: isMock ? `${origin}/p/${record.id}` : undefined,
		expires_at: record.expires_at,
		created_at: record.created_at,
		paid_at: record.paid_at,
		failure_reason: record.failure_reason,
	};
}

async function createPayment(req: Request, env: WorkerEnv): Promise<Response> {
	const body = (await req.json().catch(() => null)) as CreatePaymentRequest | null;
	if (!body || !body.order_id || typeof body.amount !== "number" || body.amount <= 0) {
		return json(
			{ success: false, message: "order_id dan amount (number > 0) wajib diisi" },
			400,
			corsHeaders(env),
		);
	}
	if (!body.callback_url) {
		return json(
			{ success: false, message: "callback_url wajib diisi untuk menerima webhook" },
			400,
			corsHeaders(env),
		);
	}

	// Idempotent: payment pending atas order yang sama → kembalikan existing.
	const existing = await getPaymentByOrder(env, body.order_id);
	if (existing && existing.status === "pending") {
		const origin = getOrigin(req);
		return json(
			{ success: true, message: "Payment pending sudah ada", data: toResponse(existing, origin) },
			200,
			corsHeaders(env),
		);
	}
	if (existing) await env.PAYMENTS.delete(`payment:${existing.id}`);

	const provider = getActiveProvider(env);
	if (!provider) {
		return json(
			{ success: false, message: "Tidak ada payment provider aktif (PAYMENT_PROVIDER kosong)" },
			400,
			corsHeaders(env),
		);
	}

	let record: PaymentRecord | null = null;
	try {
		record = await provider.create(env, body);
	} catch (e) {
		console.error("provider create failed", { provider: provider.id, error: e });
	}
	if (!record) {
		return json(
			{
				success: false,
				message: `Provider ${provider.id} gagal membuat payment (cek konfigurasi / balance)`,
			},
			502,
			corsHeaders(env),
		);
	}

	await putPayment(env, record);

	const origin = getOrigin(req);
	return json(
		{ success: true, message: "Payment intent dibuat", data: toResponse(record, origin) },
		201,
		corsHeaders(env),
	);
}

function publicPayment(payment: PaymentRecord, origin: string) {
	return toResponse(payment, origin);
}

async function getPaymentHandler(req: Request, env: WorkerEnv, id: string): Promise<Response> {
	let payment = await getPayment(env, id);
	if (!payment)
		return json({ success: false, message: "Payment tidak ditemukan" }, 404, corsHeaders(env));

	// Lazy expire: saat dipoll, jika sudah lewat masa berlaku, tandai expired + kirim webhook.
	const nowSec = Math.floor(Date.now() / 1000);
	if (payment.status === "pending" && payment.expires_at < nowSec) {
		payment.status = "expired";
		payment.failure_reason = "Waktu pembayaran habis";
		await putPayment(env, payment);
		await queueWebhook(env, payment);
	}

	const origin = getOrigin(req);
	return json({ success: true, data: publicPayment(payment, origin) }, 200, corsHeaders(env));
}

async function payOrFail(
	req: Request,
	env: WorkerEnv,
	id: string,
	action: "pay" | "fail",
	ctx: ExecutionContext,
): Promise<Response> {
	const payment = await getPayment(env, id);
	if (!payment)
		return json({ success: false, message: "Payment tidak ditemukan" }, 404, corsHeaders(env));

	const nowSec = Math.floor(Date.now() / 1000);
	if (payment.status !== "pending") {
		return json(
			{
				success: true,
				message: "Payment sudah bukan pending",
				data: publicPayment(payment, getOrigin(req)),
			},
			200,
			corsHeaders(env),
		);
	}
	if (payment.expires_at < nowSec) {
		payment.status = "expired";
		payment.failure_reason = "Waktu pembayaran habis";
		await putPayment(env, payment);
		await queueWebhook(env, payment);
		return json(
			{
				success: true,
				message: "Payment sudah kadaluarsa",
				data: publicPayment(payment, getOrigin(req)),
			},
			200,
			corsHeaders(env),
		);
	}

	if (action === "pay") {
		payment.status = "paid";
		payment.paid_at = new Date().toISOString();
	} else {
		payment.status = "failed";
		payment.failure_reason = "Pembayaran dibatalkan oleh pengguna";
	}

	await putPayment(env, payment);
	await deliverNow(env, payment, ctx);

	const message =
		action === "pay" ? "Pembayaran berhasil disimulasikan" : "Pembayaran ditandai gagal (simulasi)";
	return json(
		{ success: true, message, data: publicPayment(payment, getOrigin(req)) },
		200,
		corsHeaders(env),
	);
}

/** Simulate pembayaran sukses via provider aktif (mock: tandai paid; pakasir: paymentsimulation). */
async function simulatePayment(
	req: Request,
	env: WorkerEnv,
	id: string,
	ctx: ExecutionContext,
): Promise<Response> {
	const payment = await getPayment(env, id);
	if (!payment)
		return json({ success: false, message: "Payment tidak ditemukan" }, 404, corsHeaders(env));

	if (payment.status !== "pending") {
		return json(
			{
				success: true,
				message: `Payment sudah ${payment.status}`,
				data: publicPayment(payment, getOrigin(req)),
			},
			200,
			corsHeaders(env),
		);
	}

	const provider = getProvider(payment.provider as PaymentProviderId);
	if (!provider.simulate) {
		return json(
			{ success: false, message: "Simulate tidak didukung provider ini" },
			400,
			corsHeaders(env),
		);
	}

	let updated: PaymentRecord | null = null;
	try {
		updated = await provider.simulate(env, payment);
	} catch (e) {
		console.error("simulate failed", { provider: provider.id, error: e });
	}
	if (!updated) {
		return json(
			{ success: false, message: "Simulasi gagal (cek sandbox/config provider)" },
			502,
			corsHeaders(env),
		);
	}

	await putPayment(env, updated);
	await deliverNow(env, updated, ctx);

	return json(
		{
			success: true,
			message: "Pembayaran sukses disimulasikan",
			data: publicPayment(updated, getOrigin(req)),
		},
		200,
		corsHeaders(env),
	);
}

/**
 * Webhook masuk dari Pakasir. Pakasir TANPA signature → diverifikasi via
 * transactiondetail (cross-check). Status valid → update KV + forward ke FS-Public.
 */
async function pakasirWebhook(
	req: Request,
	env: WorkerEnv,
	ctx: ExecutionContext,
): Promise<Response> {
	const rawBody = await req.text();

	const providers = [getProvider("pakasir")];
	const result = await providers[0].verifyWebhook!(env, rawBody, req.headers);

	if (!result.ok || !result.order_id) {
		return json({ success: true, received: true, verified: false }, 200); // ack, jangan retry
	}

	const payment = await getPaymentByOrder(env, result.order_id);
	if (!payment) {
		return json({ success: true, received: true, verified: true, message: "order unknown" }, 200);
	}

	// Idempotent: jangan menimpa status final.
	if (payment.status === "paid" || payment.status === "failed" || payment.status === "expired") {
		return json({ success: true, received: true, deduplicated: true }, 200);
	}

	if (result.status === "paid") {
		payment.status = "paid";
		payment.paid_at = result.paid_at || new Date().toISOString();
	}
	// pending → biarkan, jangan apply; webhook dianggap ack.
	if (result.provider_data) {
		payment.provider_data = { ...(payment.provider_data || {}), ...result.provider_data };
	}

	await putPayment(env, payment);
	if (payment.status === "paid") {
		await deliverNow(env, payment, ctx);
	}

	return json({ success: true, received: true, verified: true }, 200);
}

async function payPage(req: Request, env: WorkerEnv, id: string): Promise<Response> {
	const payment = await getPayment(env, id);
	if (!payment) {
		return new Response("Payment tidak ditemukan", {
			status: 404,
			headers: { "Content-Type": "text/plain" },
		});
	}
	const origin = getOrigin(req);
	return new Response(renderPayPage(payment, origin), {
		status: 200,
		headers: { "Content-Type": "text/html; charset=utf-8" },
	});
}

async function adminList(env: WorkerEnv): Promise<Response> {
	const payments = await listPayments(env);
	const rows = payments
		.map((p) => ({
			payment_id: p.id,
			order_id: p.order_id,
			provider: p.provider,
			status: p.status,
			amount: p.amount,
			currency: p.currency,
			payment_code: p.payment_code,
			created_at: p.created_at,
			paid_at: p.paid_at,
			webhook_delivered: p.webhook_delivered,
			webhook_attempts: p.webhook_attempts,
		}))
		.sort((a, b) => b.created_at.localeCompare(a.created_at));
	return json({ success: true, data: rows }, 200);
}

async function cronHandler(env: WorkerEnv): Promise<Response> {
	const nowSec = Math.floor(Date.now() / 1000);
	const payments = await listPayments(env);
	let expired = 0;
	let reconciled = 0;
	let webhookResult = { delivered: 0, skipped: 0 };

	for (const payment of payments) {
		if (payment.status === "pending" && payment.expires_at < nowSec) {
			payment.status = "expired";
			payment.failure_reason = "Waktu pembayaran habis";
			await putPayment(env, payment);
			await queueWebhook(env, payment);
			expired++;
			continue;
		}

		// Reconcile: provider eksternal (pakasir) — cek status real via transactiondetail.
		if (payment.status === "pending" && payment.provider === "pakasir") {
			const provider = getProvider("pakasir");
			if (provider.syncStatus) {
				try {
					const current = await provider.syncStatus(env, payment);
					if (current && current.status === "paid") {
						await putPayment(env, current);
						await queueWebhook(env, current);
						reconciled++;
					}
				} catch (e) {
					console.error("reconcile failed", { order_id: payment.order_id, error: e });
				}
			}
		}
	}

	webhookResult = await retryPendingWebhooks(env);
	return json({ success: true, expired, reconciled, webhookResult }, 200);
}

async function handleFetch(req: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(req.url);
	const path = url.pathname;

	if (req.method === "OPTIONS") {
		return new Response(null, { status: 204, headers: corsHeaders(env) });
	}

	const withCors = <T extends Response>(res: T): T => {
		res.headers.set("Access-Control-Allow-Origin", corsHeaders(env)["Access-Control-Allow-Origin"]);
		res.headers.set(
			"Access-Control-Allow-Methods",
			corsHeaders(env)["Access-Control-Allow-Methods"],
		);
		res.headers.set(
			"Access-Control-Allow-Headers",
			corsHeaders(env)["Access-Control-Allow-Headers"],
		);
		return res;
	};

	try {
		if (req.method === "GET" && path === "/health") {
			const provider = normalizeProvider(env);
			return withCors(
				json({ success: true, status: "ok", service: "payment-service", provider }, 200),
			);
		}

		if (req.method === "POST" && path === "/v1/payments") {
			return withCors(await createPayment(req, env));
		}

		const paymentMatch = path.match(/^\/v1\/payments\/([^/]+)$/);
		const payActionMatch = path.match(/^\/v1\/payments\/([^/]+)\/(pay|fail)$/);
		const simulateMatch = path.match(/^\/v1\/payments\/([^/]+)\/simulate$/);
		const payPageMatch = path.match(/^\/p\/([^/]+)$/);

		if (req.method === "GET" && paymentMatch) {
			return withCors(await getPaymentHandler(req, env, paymentMatch[1]));
		}

		if (req.method === "POST" && payActionMatch) {
			// Sandbox quick action (mock provider). Untuk pakasir gunakan /simulate.
			return withCors(
				await payOrFail(req, env, payActionMatch[1], payActionMatch[2] as "pay" | "fail", ctx),
			);
		}

		if (req.method === "POST" && simulateMatch) {
			return withCors(await simulatePayment(req, env, simulateMatch[1], ctx));
		}

		if (req.method === "POST" && path === "/webhooks/pakasir") {
			return withCors(await pakasirWebhook(req, env, ctx));
		}

		if (req.method === "GET" && payPageMatch) {
			return await payPage(req, env, payPageMatch[1]);
		}

		if (req.method === "GET" && (path === "/admin" || path === "/admin/")) {
			return withCors(await adminList(env));
		}

		return withCors(json({ success: false, message: "Route tidak ditemukan" }, 404));
	} catch (err: unknown) {
		console.error("handler error", err);
		const message = err instanceof Error ? err.message : "Internal error";
		return withCors(json({ success: false, message }, 500));
	}
}

export default {
	async scheduled(
		controller: ScheduledController,
		env: WorkerEnv,
		ctx: ExecutionContext,
	): Promise<void> {
		ctx.waitUntil(cronHandler(env));
	},
	async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
		return handleFetch(request, env, ctx);
	},
} satisfies ExportedHandler<WorkerEnv>;
