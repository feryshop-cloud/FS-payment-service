import { env, SELF, fetchMock } from "cloudflare:test";
import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { listPayments, listWebhookQueue } from "../src/storage";
import { signPayload } from "../src/webhook";
import type { WorkerEnv } from "../src/types";

const CB_URL = "https://fs-public.example.com/api/webhooks/payment";

async function svixSignature(
	secret: string,
	svixId: string,
	ts: number,
	body: string,
): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (c) => c.charCodeAt(0)),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(`${svixId}.${ts}.${body}`),
	);
	return btoa(
		Array.from(new Uint8Array(sig))
			.map((b) => String.fromCharCode(b))
			.join(""),
	);
}

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

describe("sumopod provider", () => {
	const SUMODOP_ENV = {
		SUMODOP_API_KEY: "test-api-key",
		SUMODOP_WEBHOOK_TOKEN: "whtok_test",
		SUMODOP_BASE_URL: "https://api-pay-sandbox.sumopod.com/api/v1",
	} as Partial<WorkerEnv>;

	const SUMODOP_BODY = {
		payment_id: "1f8e7b6a-3c4d-5e6f-8a9b-0c1d2e3f4a5b",
		order_id: "TSON-123456",
		amount: 50000,
		fee: 750,
		net_amount: 49250,
		payment_link_url: "https://pay.sumopod.com/pay/abc123",
		status: "pending",
		expires_at: "2026-06-19T12:00:00Z",
	};

	it("create -> payment_url hosted page + total_payment/fee dari response", async () => {
		const { SumodopProvider } = await import("../src/providers/sumopod");
		fetchMock
			.get("https://api-pay-sandbox.sumopod.com")
			.intercept({
				method: "POST",
				path: "/api/v1/payments",
				headers: { "X-Api-Key": "test-api-key" },
			})
			.reply(200, SUMODOP_BODY);

		const record = await SumodopProvider.create(
			{ ...(env as WorkerEnv), ...SUMODOP_ENV },
			{
				order_id: "TSON-123456",
				amount: 50000,
				callback_url: CB_URL,
				return_url: "https://example.com/invoices/TSON-123456",
			},
		);

		expect(record).not.toBeNull();
		expect(record!.provider).toBe("sumopod");
		expect(record!.payment_url).toBe(SUMODOP_BODY.payment_link_url);
		expect(record!.total_payment).toBe(50000);
		expect(record!.fee).toBe(750);
		expect(record!.payment_method).toBe("qris");
		expect(record!.payment_code).toBe("");
		expect(record!.expires_at).toBe(new Date(SUMODOP_BODY.expires_at).getTime() / 1000);
	});

	it("create tanpa SUMODOP_API_KEY -> null (provider tidak aktif)", async () => {
		const { SumodopProvider } = await import("../src/providers/sumopod");
		const record = await SumodopProvider.create({} as WorkerEnv, {
			order_id: "TSON-X",
			amount: 1000,
			callback_url: CB_URL,
		});
		expect(record).toBeNull();
	});

	it("create gagal -> null", async () => {
		const { SumodopProvider } = await import("../src/providers/sumopod");
		fetchMock
			.get("https://api-pay-sandbox.sumopod.com")
			.intercept({ method: "POST", path: "/api/v1/payments" })
			.reply(500, {});
		const record = await SumodopProvider.create(
			{ ...(env as WorkerEnv), ...SUMODOP_ENV },
			{ order_id: "TSON-777", amount: 10000, callback_url: CB_URL },
		);
		expect(record).toBeNull();
	});

	it("verifyWebhook: token valid + payment.completed -> paid", async () => {
		const { SumodopProvider } = await import("../src/providers/sumopod");
		const result = await SumodopProvider.verifyWebhook!(
			{ ...(env as WorkerEnv), ...SUMODOP_ENV },
			JSON.stringify({
				event_type: "payment.completed",
				data: {
					payment_id: SUMODOP_BODY.payment_id,
					order_id: "TSON-123456",
					amount: 50000,
					fee: 750,
					net_amount: 49250,
					status: "completed",
					payment_method: "qris",
					completed_at: "2026-06-18T12:00:00Z",
				},
			}),
			new Headers({ "X-Webhook-Token": "whtok_test" }),
		);
		expect(result.ok).toBe(true);
		expect(result.status).toBe("paid");
		expect(result.order_id).toBe("TSON-123456");
	});

	it("verifyWebhook: token salah -> ditolak", async () => {
		const { SumodopProvider } = await import("../src/providers/sumopod");
		const result = await SumodopProvider.verifyWebhook!(
			{ ...(env as WorkerEnv), ...SUMODOP_ENV },
			JSON.stringify({ event_type: "payment.completed", data: { order_id: "X" } }),
			new Headers({ "X-Webhook-Token": "salah" }),
		);
		expect(result.ok).toBe(false);
	});

	it("verifyWebhook: svix signature valid -> failed", async () => {
		const { SumodopProvider } = await import("../src/providers/sumopod");
		const secret = "whsec_" + btoa("sumopod-test-secret-0123456789");
		const ts = Math.floor(Date.now() / 1000);
		const body = JSON.stringify({
			event_type: "payment.failed",
			data: { order_id: "TSON-123456", amount: 50000, status: "failed" },
		});
		const sig = await svixSignature(secret, "msg_123", ts, body);
		const result = await SumodopProvider.verifyWebhook!(
			{
				...(env as WorkerEnv),
				...SUMODOP_ENV,
				SUMODOP_WEBHOOK_TOKEN: undefined,
				SUMODOP_WEBHOOK_SECRET: secret,
			},
			body,
			new Headers({
				"svix-id": "msg_123",
				"svix-timestamp": String(ts),
				"svix-signature": `v1,${sig}`,
			}),
		);
		expect(result.ok).toBe(true);
		expect(result.status).toBe("failed");
	});

	it("verifyWebhook: tanpa token/secret terkonfigurasi -> ditolak", async () => {
		const { SumodopProvider } = await import("../src/providers/sumopod");
		const result = await SumodopProvider.verifyWebhook!(
			{ ...(env as WorkerEnv), SUMODOP_API_KEY: "k", SUMODOP_WEBHOOK_TOKEN: undefined },
			JSON.stringify({ event_type: "payment.completed", data: { order_id: "X" } }),
			new Headers(),
		);
		expect(result.ok).toBe(false);
	});

	it("simulate tidak didukung sumopod -> 400", async () => {
		const { putPayment } = await import("../src/storage");
		await putPayment(
			env as WorkerEnv,
			{
				id: "sm_simtest",
				order_id: "TSON-SIM",
				provider: "sumopod",
				amount: 50000,
				currency: "IDR",
				payment_code: "",
				status: "pending",
				created_at: new Date().toISOString(),
				expires_at: Math.floor(Date.now() / 1000) + 300,
				callback_url: CB_URL,
				webhook_delivered: false,
				webhook_attempts: 0,
			} as never,
		);

		const res = await SELF.fetch("https://example.com/v1/payments/sm_simtest/simulate", {
			method: "POST",
		});
		const body = (await res.json()) as { success: boolean };
		expect(res.status).toBe(400);
		expect(body.success).toBe(false);
	});

	it("route /webhooks/sumopod terdaftar (ack tanpa config API key)", async () => {
		const res = await SELF.fetch("https://example.com/webhooks/sumopod", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				event_type: "payment.test",
				data: { order_id: "X" },
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { success: boolean; verified: boolean };
		expect(body.success).toBe(true);
		expect(body.verified).toBe(false);
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

describe("sandbox action & URL validation", () => {
	it("pay action pada payment non-mock -> 403", async () => {
		const { putPayment } = await import("../src/storage");
		await putPayment(
			env as WorkerEnv,
			{
				id: "sm_guard",
				order_id: "TSON-GUARD",
				provider: "sumopod",
				amount: 10000,
				currency: "IDR",
				payment_code: "",
				status: "pending",
				created_at: new Date().toISOString(),
				expires_at: Math.floor(Date.now() / 1000) + 300,
				callback_url: CB_URL,
				webhook_delivered: false,
				webhook_attempts: 0,
			} as never,
		);

		const res = await SELF.fetch("https://example.com/v1/payments/sm_guard/pay", {
			method: "POST",
		});
		expect(res.status).toBe(403);

		const fail = await SELF.fetch("https://example.com/v1/payments/sm_guard/fail", {
			method: "POST",
		});
		expect(fail.status).toBe(403);
	});

	it("create menolak callback_url non-http(s)", async () => {
		const res = await SELF.fetch("https://example.com/v1/payments", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				order_id: "TSON-CB",
				amount: 1000,
				callback_url: "ftp://example.com/hook",
			}),
		});
		expect(res.status).toBe(400);
	});

	it("create menolak return_url javascript:", async () => {
		const res = await SELF.fetch("https://example.com/v1/payments", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				order_id: "TSON-RET",
				amount: 1000,
				callback_url: CB_URL,
				return_url: "javascript:alert(1)",
			}),
		});
		expect(res.status).toBe(400);
	});

	it("pay page meng-escape return_url dari breakout script", async () => {
		const { json } = await createPayment({
			return_url: "https://x.com/</script><script>alert(1)</script>",
		});
		const res = await SELF.fetch(`https://example.com/p/${json.data.payment_id}`);
		const html = await res.text();
		expect(html).not.toContain("</script><script>alert(1)");
		expect(html).toContain("\\u003c/script\\u003e");
	});
});

describe("hardening: SSRF / admin token / CORS / webhook secret", () => {
	it("create menolak callback_url ke localhost/private (SSRF guard)", async () => {
		for (const url of [
			"http://localhost:3000/hook",
			"http://127.0.0.1/hook",
			"http://10.0.0.5/hook",
			"http://192.168.1.1/hook",
			"http://169.254.169.254/latest/meta-data",
			"http://[::1]:3000/hook",
		]) {
			const res = await SELF.fetch("https://example.com/v1/payments", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					order_id: `TSON-SSRF-${Math.random()}`,
					amount: 1000,
					callback_url: url,
				}),
			});
			expect(res.status, url).toBe(400);
		}
	});

	it("adminTokenOk: cocok constant-time, tanpa token = terbuka", async () => {
		const { adminTokenOk } = await import("../src/index");
		const envT = { SANDBOX_ADMIN_TOKEN: "rahasia-admin" } as WorkerEnv;
		expect(
			adminTokenOk(envT, new Request("https://x.com/admin", { headers: { "X-Payment-Admin-Token": "rahasia-admin" } })),
		).toBe(true);
		expect(adminTokenOk(envT, new Request("https://x.com/admin", { headers: { "X-Payment-Admin-Token": "salah" } }))).toBe(
			false,
		);
		expect(adminTokenOk(envT, new Request("https://x.com/admin"))).toBe(false);
		expect(adminTokenOk({} as WorkerEnv, new Request("https://x.com/admin"))).toBe(true);
	});

	it("corsHeaders: echo origin yang diizinkan, bukan join list", async () => {
		const { corsHeaders } = await import("../src/index");
		const envC = { ALLOWED_ORIGINS: "https://app.example.com, https://admin.example.com" } as WorkerEnv;
		expect(corsHeaders(envC, "https://app.example.com")["Access-Control-Allow-Origin"]).toBe(
			"https://app.example.com",
		);
		expect(corsHeaders(envC, "https://evil.example.com")["Access-Control-Allow-Origin"]).toBeUndefined();
		expect(corsHeaders(envC, "")["Access-Control-Allow-Origin"]).toBeUndefined();
		expect(corsHeaders({} as WorkerEnv, "https://x.com")["Access-Control-Allow-Origin"]).toBe("*");
	});

	it("deliverWebhook: tanpa secret -> ditolak (fail-closed)", async () => {
		const { deliverWebhook } = await import("../src/webhook");
		const item = {
			id: "wh_x",
			payment_id: "p1",
			order_id: "o1",
			event: "payment.paid",
			callback_url: CB_URL,
			payload: {
				event: "payment.paid",
				event_id: "evt_x",
				payment_id: "p1",
				order_id: "o1",
				status: "paid",
				amount: 1000,
				currency: "IDR",
				payment_code: "",
				timestamp: new Date().toISOString(),
			},
			queued_at: new Date().toISOString(),
			attempts: 0,
		} as never;
		expect(await deliverWebhook({} as WorkerEnv, item)).toBe(false);
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
