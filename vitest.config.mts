import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: "./wrangler.jsonc" },
				// Test selalu berjalan dengan mock provider — jangan ikut PAYMENT_PROVIDER
				// dari wrangler.jsonc (bisa ter-set ke provider live seperti sumopod).
				miniflare: {
					bindings: {
						PAYMENT_PROVIDER: "mock",
						PAYMENT_WEBHOOK_SECRET: "test-webhook-secret",
					},
				},
			},
		},
	},
});
