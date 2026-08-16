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
import { logger, setRequestId } from "./utils/logger";

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json",
			...headers,
		},
	});

function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/** Aksi sandbox (/pay, /fail, /simulate) hanya boleh saat token admin disediakan (jika dikonfigurasi). */
export function adminTokenOk(env: WorkerEnv, req: Request): boolean {
	const token = env.SANDBOX_ADMIN_TOKEN;
	if (!token) return true; // dev mode tanpa token → terbuka (mock only).
	const provided = req.headers.get("x-payment-admin-token") || "";
	return safeEqual(provided, token);
}

function isValidHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

/** SSRF guard: blokir host yang mengarah ke localhost / jaringan privat. */
function isPrivateIpv4(hostname: string): boolean {
	const parts = hostname.split(".");
	if (parts.length !== 4) return false;
	const nums = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
	if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
	const [a, b] = nums;
	if (a === 0 || a === 10 || a === 127 || a === 169) return true; // 169.254.169.254 metadata ikut terblokir
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 198 && (b === 18 || b === 19)) return true;
	if (a >= 240) return true; // reserved
	return false;
}

function isPrivateHost(hostname: string): boolean {
	const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (h === "localhost" || h.endsWith(".localhost")) return true;
	if (/(^|\.)(local|lan|internal|localdomain|home|corp)$/.test(h)) return true;

	if (h.includes(":")) {
		if (h === "::" || h === "::1") return true;
		if (h.startsWith("::ffff:")) return isPrivateIpv4(h.slice(7));
		if (h.startsWith("fc") || h.startsWith("fd")) return true; // fc00::/7 (ULA)
		if (/^fe[89ab]/.test(h)) return true; // fe80::/10 (link-local)
		if (h.startsWith("2001:db8")) return true; // dokumentasi
		return false;
	}

	return isPrivateIpv4(h);
}

function parseAllowedOrigins(env: WorkerEnv): string[] {
	return (env.ALLOWED_ORIGINS || "*")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

/** CORS: echo Origin peminta hanya bila tercantum di ALLOWED_ORIGINS (bukan join string). */
export const corsHeaders = (env: WorkerEnv, origin = ""): Record<string, string> => {
	const allowed = parseAllowedOrigins(env);
	const headers: Record<string, string> = {
		"Access-Control-Allow-Methods": "GET,POST,OPTIONS,PATCH",
		"Access-Control-Allow-Headers":
			"Content-Type, Authorization, x-payment-signature, x-mock-signature, x-payment-event, x-payment-idempotency, x-request-id",
		"Access-Control-Expose-Headers": "x-request-id",
		"Access-Control-Max-Age": "86400",
	};
	if (allowed.includes("*")) {
		headers["Access-Control-Allow-Origin"] = "*";
	} else if (origin && allowed.includes(origin)) {
		headers["Access-Control-Allow-Origin"] = origin;
	}
	return headers;
};

function reqOrigin(req: Request): string {
	return req.headers.get("Origin") || "";
}

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
		// Mock: halaman simulasi di worker sendiri. SumoPod: hosted page provider.
		// Pakasir API mode: tanpa hosted page.
		payment_url: record.payment_url ?? (isMock ? `${origin}/p/${record.id}` : undefined),
		expires_at: record.expires_at,
		created_at: record.created_at,
		paid_at: record.paid_at,
		failure_reason: record.failure_reason,
	};
}

/**
 * Creates a new payment intent using the configured active payment provider (mock or pakasir).
 * Idempotent: Returns existing pending payment if one already exists for the given `order_id`.
 *
 * @param req - HTTP Request containing `CreatePaymentRequest` body payload.
 * @param env - Cloudflare Worker environment bindings.
 * @returns Response JSON containing payment intent data (`CreatePaymentResponse`).
 */
async function createPayment(req: Request, env: WorkerEnv): Promise<Response> {
	const body = (await req.json().catch(() => null)) as CreatePaymentRequest | null;
	if (!body || !body.order_id || typeof body.amount !== "number" || body.amount <= 0) {
		logger.debug("create payment validation failed", { hasBody: !!body, hasOrderId: !!body?.order_id, amount: body?.amount });
		return json(
			{ success: false, message: "order_id dan amount (number > 0) wajib diisi" },
			400,
			corsHeaders(env),
		);
	}
	if (!body.callback_url || !isValidHttpUrl(body.callback_url)) {
		logger.debug("create payment invalid callback_url", { callback_url: body.callback_url });
		return json(
			{ success: false, message: "callback_url wajib diisi dan harus berupa URL http(s)" },
			400,
			corsHeaders(env),
		);
	}
	const allowPrivateCallback = env.ALLOW_PRIVATE_CALLBACKS === "true";
	if (!allowPrivateCallback && isPrivateHost(new URL(body.callback_url).hostname)) {
		logger.warn("create payment blocked private callback", { callback_url: body.callback_url });
		return json(
			{ success: false, message: "callback_url menuju host pribadi (localhost/private) tidak diizinkan" },
			400,
			corsHeaders(env),
		);
	}
	if (body.return_url && !isValidHttpUrl(body.return_url)) {
		logger.debug("create payment invalid return_url", { return_url: body.return_url });
		return json(
			{ success: false, message: "return_url harus berupa URL http(s)" },
			400,
			corsHeaders(env),
		);
	}

	// Idempotent: payment pending atas order yang sama → kembalikan existing.
	const existing = await getPaymentByOrder(env, body.order_id);
	if (existing && existing.status === "pending") {
		logger.warn("create payment idempotent hit", { order_id: body.order_id, payment_id: existing.id });
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
		logger.warn("create payment no active provider", { PAYMENT_PROVIDER: env.PAYMENT_PROVIDER });
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
		logger.error("provider create failed", { provider: provider.id, error: e });
	}
	if (!record) {
		logger.error("provider create returned null", { provider: provider.id, order_id: body.order_id });
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
	logger.info("payment intent created", { payment_id: record.id, order_id: record.order_id, provider: record.provider, amount: record.amount, expires_at: record.expires_at });

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
	if (!payment) {
		logger.debug("payment not found", { payment_id: id });
		return json({ success: false, message: "Payment tidak ditemukan" }, 404, corsHeaders(env));
	}

	// Lazy expire: saat dipoll, jika sudah lewat masa berlaku, tandai expired + kirim webhook.
	const nowSec = Math.floor(Date.now() / 1000);
	if (payment.status === "pending" && payment.expires_at < nowSec) {
		logger.info("payment lazy expired", { payment_id: id, order_id: payment.order_id });
		payment.status = "expired";
		payment.failure_reason = "Waktu pembayaran habis";
		await putPayment(env, payment);
		await queueWebhook(env, payment);
	}

	logger.debug("payment retrieved", { payment_id: id, order_id: payment.order_id, status: payment.status });
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
	if (!payment) {
		logger.debug("sandbox action payment not found", { payment_id: id, action });
		return json({ success: false, message: "Payment tidak ditemukan" }, 404, corsHeaders(env));
	}

	// Aksi sandbox: hanya untuk payment mock (simulasi dev). Provider produksi ditolak.
	if (payment.provider !== "mock") {
		logger.warn("sandbox action blocked non-mock provider", { payment_id: id, provider: payment.provider, action });
		return json(
			{ success: false, message: "Aksi sandbox hanya berlaku untuk provider mock" },
			403,
			corsHeaders(env),
		);
	}
	if (!adminTokenOk(env, req)) {
		logger.warn("sandbox action unauthorized", { payment_id: id, action });
		return json({ success: false, message: "Akses sandbox ditolak" }, 403, corsHeaders(env));
	}

	const nowSec = Math.floor(Date.now() / 1000);
	if (payment.status !== "pending") {
		logger.info("sandbox action skipped already processed", { payment_id: id, status: payment.status, action });
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
		logger.warn("sandbox action skipped expired", { payment_id: id, action });
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
	logger.info("sandbox action completed", { payment_id: id, action, status: payment.status });

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
	if (!payment) {
		logger.debug("simulate payment not found", { payment_id: id });
		return json({ success: false, message: "Payment tidak ditemukan" }, 404, corsHeaders(env));
	}

	if (!adminTokenOk(env, req)) {
		logger.warn("simulate unauthorized", { payment_id: id });
		return json({ success: false, message: "Akses sandbox ditolak" }, 403, corsHeaders(env));
	}

	if (payment.status !== "pending") {
		logger.info("simulate skipped already processed", { payment_id: id, status: payment.status });
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
		logger.warn("simulate unsupported provider", { payment_id: id, provider: payment.provider });
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
		logger.error("simulate failed", { provider: provider.id, error: e });
	}
	if (!updated) {
		logger.error("simulate returned null", { payment_id: id, provider: payment.provider });
		return json(
			{ success: false, message: "Simulasi gagal (cek sandbox/config provider)" },
			502,
			corsHeaders(env),
		);
	}

	await putPayment(env, updated);
	await deliverNow(env, updated, ctx);
	logger.info("payment simulated", { payment_id: id, status: updated.status, provider: updated.provider });

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
 * Webhook masuk dari provider eksternal (pakasir / sumopod).
 * Pakasir TANPA signature → diverifikasi via transactiondetail (cross-check).
 * SumoPod → verifikasi X-Webhook-Token atau Svix signature.
 * Status valid → update KV + forward ke FS-Public.
 */
async function providerWebhook(
	req: Request,
	env: WorkerEnv,
	ctx: ExecutionContext,
	providerId: PaymentProviderId,
): Promise<Response> {
	const rawBody = await req.text();
	logger.debug("provider webhook received", { provider: providerId, bodyLength: rawBody.length });

	const provider = getProvider(providerId);
	if (!provider.verifyWebhook) {
		logger.warn("provider webhook no verifier", { provider: providerId });
		return json({ success: true, received: true, verified: false }, 200); // ack, jangan retry
	}

	const result = await provider.verifyWebhook(env, rawBody, req.headers);

	if (!result.ok || !result.order_id) {
		logger.warn("provider webhook verification failed", { provider: providerId, ok: result.ok });
		return json({ success: true, received: true, verified: false }, 200); // ack, jangan retry
	}

	logger.debug("provider webhook verified", { provider: providerId, order_id: result.order_id, status: result.status });

	const payment = await getPaymentByOrder(env, result.order_id);
	if (!payment) {
		logger.warn("provider webhook unknown order", { provider: providerId, order_id: result.order_id });
		return json({ success: true, received: true, verified: true, message: "order unknown" }, 200);
	}

	// Idempotent: jangan menimpa status final.
	if (payment.status !== "pending") {
		logger.debug("provider webhook deduplicated", { payment_id: payment.id, status: payment.status });
		return json({ success: true, received: true, deduplicated: true }, 200);
	}

	const prevStatus = payment.status;
	if (result.status === "paid") {
		payment.status = "paid";
		payment.paid_at = result.paid_at || new Date().toISOString();
	} else if (result.status === "failed") {
		payment.status = "failed";
		payment.failure_reason = result.failure_reason || "Pembayaran gagal di gateway";
	} else if (result.status === "expired") {
		payment.status = "expired";
		payment.failure_reason = "Waktu pembayaran habis";
	}
	// pending → biarkan, jangan apply; webhook dianggap ack.
	if (result.provider_data) {
		payment.provider_data = { ...(payment.provider_data || {}), ...result.provider_data };
	}

	await putPayment(env, payment);
	if (payment.status !== "pending") {
		logger.info("provider webhook status changed", { payment_id: payment.id, order_id: payment.order_id, prevStatus, nextStatus: payment.status, provider: providerId });
		await deliverNow(env, payment, ctx);
	}

	return json({ success: true, received: true, verified: true }, 200);
}

async function payPage(req: Request, env: WorkerEnv, id: string): Promise<Response> {
	const payment = await getPayment(env, id);
	if (!payment) {
		logger.debug("pay page not found", { payment_id: id });
		return new Response("Payment tidak ditemukan", {
			status: 404,
			headers: { "Content-Type": "text/plain" },
		});
	}
	logger.debug("pay page served", { payment_id: id, status: payment.status });
	const origin = getOrigin(req);
	return new Response(renderPayPage(payment, origin), {
		status: 200,
		headers: { "Content-Type": "text/html; charset=utf-8" },
	});
}

async function adminList(env: WorkerEnv): Promise<Response> {
	logger.info("admin list accessed");
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

	logger.info("cron started", { totalPayments: payments.length, nowSec });

	for (const payment of payments) {
		if (payment.status === "pending" && payment.expires_at < nowSec) {
			logger.debug("cron expiring payment", { payment_id: payment.id, order_id: payment.order_id });
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
					logger.error("reconcile failed", { order_id: payment.order_id, error: e });
				}
			}
		}
	}

	webhookResult = await retryPendingWebhooks(env);
	logger.info("cron completed", { expired, reconciled, webhookDelivered: webhookResult.delivered, webhookSkipped: webhookResult.skipped });
	return json({ success: true, expired, reconciled, webhookResult }, 200);
}

async function handleFetch(req: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(req.url);
	const path = url.pathname;
	const requestId = req.headers.get("x-request-id") || undefined;
	setRequestId(requestId);

	if (req.method === "OPTIONS") {
		const res = new Response(null, { status: 204, headers: corsHeaders(env, reqOrigin(req)) });
		if (requestId) res.headers.set("x-request-id", requestId);
		return res;
	}

	const withCors = <T extends Response>(res: T): T => {
		for (const [key, value] of Object.entries(corsHeaders(env, reqOrigin(req)))) {
			res.headers.set(key, value);
		}
		if (requestId) res.headers.set("x-request-id", requestId);
		return res;
	};

	try {
		logger.info("request received", { method: req.method, path });

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
			return withCors(await providerWebhook(req, env, ctx, "pakasir"));
		}

		if (req.method === "POST" && path === "/webhooks/sumopod") {
			return withCors(await providerWebhook(req, env, ctx, "sumopod"));
		}

		if (req.method === "GET" && payPageMatch) {
			return await payPage(req, env, payPageMatch[1]);
		}

		if (req.method === "GET" && (path === "/admin" || path === "/admin/")) {
			if (!adminTokenOk(env, req)) {
				return withCors(json({ success: false, message: "Akses admin ditolak" }, 403));
			}
			return withCors(await adminList(env));
		}

		return withCors(json({ success: false, message: "Route tidak ditemukan" }, 404));
	} catch (err: unknown) {
		logger.error("handler error", { err });
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
