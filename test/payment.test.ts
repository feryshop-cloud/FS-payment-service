import { env, SELF, fetchMock } from "cloudflare:test";
import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { listPayments, listWebhookQueue } from "../src/storage";
import { signPayload } from "../src/webhook";
import type { WorkerEnv } from "../src/types";

const CB_URL = "https://fs-public.example.com/api/webhooks/payment";

async function createPayment(overrides: Record<string, unknown> = {}) {
	const res = await SELF.fetch("https://example.com/v1/payments", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			order_id: "TSON-123456",
			amount: 50000,
			currency: "IDR",
			description: "Topup Mobile Legends 50 Diamond",
			customer: { name: "Budi Test", email: "budi@test.dev" },
			callback_url: CB_URL,
			return_url: "https://example.com/invoices/TSON-123456",
			...overrides,
		}),
	});
	const json = (await res.json()) as {
		success: boolean;
		data: Record<string, unknown>;
		message?: string;
	};
	return { res, json };
}

beforeEach(async () => {
	fetchMock.activate();
	fetchMock.disableNetConnect();

	for (const p of await listPayments(env as WorkerEnv)) {
		await (env as WorkerEnv).PAYMENTS.delete(`payment:${p.id}`);
		await (env as WorkerEnv).PAYMENTS.delete(`order:${p.order_id}`);
	}
	for (const q of await listWebhookQueue(env as WorkerEnv)) {
		await (env as WorkerEnv).PAYMENTS.delete(`webhook:${q.id}`);
	}
});

describe("create payment intent", () => {
	it("membuat payment intent baru", async () => {
		const { res, json } = await createPayment();

		expect(res.status).toBe(201);
		expect(json.success).toBe(true);
		expect(json.data.payment_id).toMatch(/^pay_/);
		expect(json.data.provider).toBe("mock");
		expect(json.data.payment_code).toMatch(/^880\d+$/);
		expect(json.data.status).toBe("pending");
		expect(json.data.amount).toBe(50000);
		expect(json.data.payment_url).toContain("/p/");
		expect(typeof json.data.expires_at).toBe("number");
	});

	it("menolak tanpa order_id / amount valid", async () => {
		const noOrder = await SELF.fetch("https://example.com/v1/payments", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ amount: 1000, callback_url: CB_URL }),
		});
		expect(noOrder.status).toBe(400);

		const noAmount = await SELF.fetch("https://example.com/v1/payments", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ order_id: "X", amount: 0, callback_url: CB_URL }),
		});
		expect(noAmount.status).toBe(400);

		const noCallback = await SELF.fetch("https://example.com/v1/payments", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ order_id: "X", amount: 1000 }),
		});
		expect(noCallback.status).toBe(400);
	});

	it("idempoten: order yang sama & masih pending mengembalikan payment yang sama", async () => {
		const first = await createPayment();
		const second = await createPayment();

		expect(second.res.status).toBe(200);
		expect(second.json.data.payment_id).toBe(first.json.data.payment_id);
		expect(second.json.data.status).toBe("pending");
	});

	it("membuat payment baru jika order sebelumnya sudah selesai", async () => {
		const first = await createPayment();
		await SELF.fetch(`https://example.com/v1/payments/${first.json.data.payment_id}/fail`, {
			method: "POST",
		});

		const second = await createPayment();
		expect(second.res.status).toBe(201);
		expect(second.json.data.payment_id).not.toBe(first.json.data.payment_id);
	});
});

describe("pakasir provider", () => {
	const PAKASIR_ENV = {
		PAYMENT_PROVIDER: "pakasir",
		PAKASIR_PROJECT: "feryshop",
		PAKASIR_API_KEY: "test-api-key",
		PAKASIR_METHOD: "qris",
		PAKASIR_SANDBOX: "true",
		PAKASIR_BASE_URL: "https://app.pakasir.com",
	} as Partial<WorkerEnv>;

	const PAKASIR_BODY = {
		payment: {
			project: "feryshop",
			order_id: "TSON-123456",
			amount: 50000,
			fee: 1500,
			total_payment: 51500,
			payment_method: "qris",
			payment_number: "00020101021226610016ID.CO.QRIS.WWW01189360091800216",
			expired_at: "2026-09-19T01:18:49.678Z",
		},
	};

	it("create qris -> qr_string + total_payment dari response pakasir", async () => {
		const { PakasirProvider } = await import("../src/providers/pakasir");
		fetchMock
			.get("https://app.pakasir.com")
			.intercept({ method: "POST", path: "/api/transactioncreate/qris" })
			.reply(200, PAKASIR_BODY);

		const record = await PakasirProvider.create(
			{ ...(env as WorkerEnv), ...PAKASIR_ENV },
			{
				order_id: "TSON-123456",
				amount: 50000,
				callback_url: CB_URL,
			},
		);

		expect(record).not.toBeNull();
		expect(record!.provider).toBe("pakasir");
		expect(record!.qr_string).toBe(PAKASIR_BODY.payment.payment_number);
		expect(record!.total_payment).toBe(51500);
		expect(record!.payment_method).toBe("qris");
	});

	it("create qris tanpa PAKASIR_PROJECT/API_KEY -> null (provider tidak aktif)", async () => {
		const { PakasirProvider } = await import("../src/providers/pakasir");
		const record = await PakasirProvider.create({} as WorkerEnv, {
			order_id: "TSON-X",
			amount: 1000,
			callback_url: CB_URL,
		});
		expect(record).toBeNull();
	});

	it("create gagal -> null", async () => {
		const { PakasirProvider } = await import("../src/providers/pakasir");
		fetchMock
			.get("https://app.pakasir.com")
			.intercept({ method: "POST", path: "/api/transactioncreate/qris" })
			.reply(500, {});
		const record = await PakasirProvider.create(
			{ ...(env as WorkerEnv), ...PAKASIR_ENV },
			{ order_id: "TSON-777", amount: 10000, callback_url: CB_URL },
		);
		expect(record).toBeNull();
	});

	it("verifyWebhook: status completed terverifikasi lewat transactiondetail", async () => {
		const { PakasirProvider } = await import("../src/providers/pakasir");
		const detailPath =
			"/api/transactiondetail?project=feryshop&amount=50000&order_id=TSON-123456&api_key=test-api-key";
		fetchMock
			.get("https://app.pakasir.com")
			.intercept({ method: "GET", path: detailPath })
			.reply(200, {
				transaction: {
					amount: 50000,
					order_id: "TSON-123456",
					project: "feryshop",
					status: "completed",
					payment_method: "qris",
					completed_at: "2026-08-14T08:07:02.819+07:00",
				},
			});

		const result = await PakasirProvider.verifyWebhook!(
			{ ...(env as WorkerEnv), ...PAKASIR_ENV },
			JSON.stringify({
				amount: 50000,
				order_id: "TSON-123456",
				project: "feryshop",
				status: "completed",
				payment_method: "qris",
			}),
			new Headers(),
		);

		expect(result.ok).toBe(true);
		expect(result.status).toBe("paid");
	});

	it("verifyWebhook: mismatch amount -> ditolak", async () => {
		const { PakasirProvider } = await import("../src/providers/pakasir");
		const detailPath =
			"/api/transactiondetail?project=feryshop&amount=50000&order_id=TSON-123456&api_key=test-api-key";
		fetchMock
			.get("https://app.pakasir.com")
			.intercept({ method: "GET", path: detailPath })
			.reply(200, {
				transaction: {
					amount: 99999,
					order_id: "TSON-123456",
					project: "feryshop",
					status: "completed",
				},
			});

		const result = await PakasirProvider.verifyWebhook!(
			{ ...(env as WorkerEnv), ...PAKASIR_ENV },
			JSON.stringify({ amount: 50000, order_id: "TSON-123456", project: "feryshop" }),
			new Headers(),
		);
		expect(result.ok).toBe(false);
	});

	it("simulate sandbox -> paymentsimulation dipanggil + paid", async () => {
		const { PakasirProvider } = await import("../src/providers/pakasir");
		fetchMock
			.get("https://app.pakasir.com")
			.intercept({ method: "POST", path: "/api/paymentsimulation" })
			.reply(200, { success: true, message: "ok" });

		const record = await PakasirProvider.simulate!(
			{ ...(env as WorkerEnv), ...PAKASIR_ENV },
			{
				id: "pk_x",
				order_id: "TSON-123456",
				provider: "pakasir",
				amount: 50000,
				currency: "IDR",
				payment_code: "880123",
				status: "pending",
				created_at: new Date().toISOString(),
				expires_at: Math.floor(Date.now() / 1000) + 300,
				webhook_delivered: false,
				webhook_attempts: 0,
			},
		);
		expect(record?.status).toBe("paid");
	});

	it("simulate saat non-sandbox -> null", async () => {
		const { PakasirProvider } = await import("../src/providers/pakasir");
		const record = await PakasirProvider.simulate!(
			{ ...(env as WorkerEnv), ...PAKASIR_ENV, PAKASIR_SANDBOX: "false" },
			{} as any,
		);
		expect(record).toBeNull();
	});
});

describe("polling & simulasi", () => {
	it("GET status mengembalikan pending", async () => {
		const { json } = await createPayment();
		const res = await SELF.fetch(`https://example.com/v1/payments/${json.data.payment_id}`);
		const body = (await res.json()) as { success: boolean; data: Record<string, unknown> };
		expect(res.status).toBe(200);
		expect(body.data.status).toBe("pending");
	});

	it("GET status 404 untuk payment tak dikenal", async () => {
		const res = await SELF.fetch("https://example.com/v1/payments/pay_doesnotexist");
		expect(res.status).toBe(404);
	});

	it("simulasi bayar -> paid + webhook di-queue", async () => {
		const { json } = await createPayment();
		const payId = json.data.payment_id as string;

		const res = await SELF.fetch(`https://example.com/v1/payments/${payId}/pay`, {
			method: "POST",
		});
		const body = (await res.json()) as {
			success: boolean;
			data: { status: string; paid_at: string };
		};
		expect(res.status).toBe(200);
		expect(body.success).toBe(true);
		expect(body.data.status).toBe("paid");
		expect(body.data.paid_at).toBeTruthy();

		const payments = await listPayments(env as WorkerEnv);
		const payment = payments.find((p) => p.id === payId);
		expect(payment?.status).toBe("paid");
		expect(payment?.paid_at).toBeTruthy();
		expect(payment?.webhook_delivered).toBe(false);

		const queue = await listWebhookQueue(env as WorkerEnv);
		expect(queue.some((q) => q.payment_id === payId && q.event === "payment.paid")).toBe(true);
	});

	it("simulasi gagal -> failed", async () => {
		const { json } = await createPayment();
		const res = await SELF.fetch(`https://example.com/v1/payments/${json.data.payment_id}/fail`, {
			method: "POST",
		});
		const body = (await res.json()) as { success: boolean; data: { status: string } };
		expect(body.data.status).toBe("failed");
	});

	it("pay dua kali: tetap paid tanpa duplikat webhook", async () => {
		const { json } = await createPayment();
		const payId = json.data.payment_id as string;
		await SELF.fetch(`https://example.com/v1/payments/${payId}/pay`, { method: "POST" });
		const second = await SELF.fetch(`https://example.com/v1/payments/${payId}/pay`, {
			method: "POST",
		});
		const body = (await second.json()) as { success: boolean; data: { status: string } };
		expect(body.data.status).toBe("paid");

		const queue = await listWebhookQueue(env as WorkerEnv);
		const paidEvents = queue.filter((q) => q.payment_id === payId && q.event === "payment.paid");
		expect(paidEvents.length).toBeLessThanOrEqual(1);
	});
});

describe("expired", () => {
	it("lazy expire: GET status menandai expired setelah expires_at lewat", async () => {
		const { json } = await createPayment({ expires_in_seconds: 999999 });
		const payId = json.data.payment_id as string;

		const payments = await listPayments(env as WorkerEnv);
		const payment = payments.find((p) => p.id === payId)!;
		payment.expires_at = Math.floor(Date.now() / 1000) - 60;
		await (env as WorkerEnv).PAYMENTS.put(`payment:${payId}`, JSON.stringify(payment));

		const res = await SELF.fetch(`https://example.com/v1/payments/${payId}`);
		const body = (await res.json()) as { success: boolean; data: { status: string } };
		expect(body.data.status).toBe("expired");

		const queue = await listWebhookQueue(env as WorkerEnv);
		expect(queue.some((q) => q.payment_id === payId && q.event === "payment.expired")).toBe(true);
	});

	it("pay pada payment yang sudah expired -> tetap expired", async () => {
		const { json } = await createPayment({ expires_in_seconds: 999999 });
		const payId = json.data.payment_id as string;

		const payments = await listPayments(env as WorkerEnv);
		const payment = payments.find((p) => p.id === payId)!;
		payment.expires_at = Math.floor(Date.now() / 1000) - 10;
		await (env as WorkerEnv).PAYMENTS.put(`payment:${payId}`, JSON.stringify(payment));

		const res = await SELF.fetch(`https://example.com/v1/payments/${payId}/pay`, {
			method: "POST",
		});
		const body = (await res.json()) as { success: boolean; data: { status: string } };
		expect(body.data.status).toBe("expired");
	});
});

describe("payment page", () => {
	it("GET /p/:id merender halaman simulasi", async () => {
		const { json } = await createPayment();
		const res = await SELF.fetch(`https://example.com/p/${json.data.payment_id}`);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("Sandbox");
		expect(html).toContain(json.data.payment_code as string);
		expect(html).toContain("Bayar Sekarang");
		expect(html).toContain("/v1/payments");
	});

	it("GET /p/:id 404 untuk payment tak dikenal", async () => {
		const res = await SELF.fetch("https://example.com/p/pay_nope");
		expect(res.status).toBe(404);
	});
});

describe("webhook delivery & signature", () => {
	beforeEach(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});

	afterEach(() => {
		fetchMock.assertNoPendingInterceptors();
	});

	it("signature HMAC konsisten antar panggilan", async () => {
		const a = await signPayload(env as WorkerEnv, '{"hello":"world"}');
		const b = await signPayload(env as WorkerEnv, '{"hello":"world"}');
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
	});

	it("kirim webhook ke callback_url dengan signature", async () => {
		fetchMock
			.get("https://fs-public.example.com")
			.intercept({ method: "POST", path: "/api/webhooks/payment" })
			.reply(200, { ok: true });

		const { json } = await createPayment();
		const payId = json.data.payment_id as string;

		await SELF.fetch(`https://example.com/v1/payments/${payId}/pay`, { method: "POST" });

		// deliverNow memakai ctx.waitUntil; retry eksplisit menjamin deterministik.
		const { retryPendingWebhooks } = await import("../src/webhook");
		await retryPendingWebhooks(env as WorkerEnv);

		const queue = await listWebhookQueue(env as WorkerEnv);
		expect(queue.filter((q) => q.payment_id === payId)).toHaveLength(0);
	});

	it("callback down -> attempts bertambah dan tetap di queue", async () => {
		const { json } = await createPayment({ callback_url: "https://unreachable.invalid/webhook" });
		const payId = json.data.payment_id as string;

		await SELF.fetch(`https://example.com/v1/payments/${payId}/fail`, { method: "POST" });

		const { retryPendingWebhooks } = await import("../src/webhook");
		const result = await retryPendingWebhooks(env as WorkerEnv);
		expect(result.delivered).toBe(0);

		const queue = await listWebhookQueue(env as WorkerEnv);
		const item = queue.find((q) => q.payment_id === payId);
		expect(item).toBeTruthy();
		expect(item!.attempts).toBeGreaterThan(0);
	});
});
