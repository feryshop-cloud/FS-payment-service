---
title: Payment Service
---

# Payment Service — Agent Guide

Cloudflare Worker payment gateway abstraction. Terpisah dari FS-Public dan terpisah secara network (deploy di Cloudflare / lokal via wrangler dev). Provider aktif dikontrol `PAYMENT_PROVIDER` (`mock` / `pakasir`).

## Struktur

| File                   | Isi                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `src/index.ts`         | Router & handler (create/status/pay/fail/simulate/pakasir-webhook/cron/admin)             |
| `src/types.ts`         | Shared types (`PaymentRecord`, `CreatePaymentResponse`, `WorkerEnv`)                      |
| `src/providers/`       | Adapter provider: `index.ts` (interface + factory), `mock.ts`, `pakasir.ts`, `sumopod.ts` |
| `src/storage.ts`       | KV wrapper (get/put/list, index by order_id, webhook queue)                               |
| `src/webhook.ts`       | HMAC sign, build payload, queue & retry webhook                                           |
| `src/pay-page.ts`      | HTML payment page (simulasi UI, mock provider)                                            |
| `test/payment.test.ts` | Vitest (pool workers, KV binding, fetchMock)                                              |

## Perintah

```
npm run dev          # wrangler dev (http://localhost:8787)
npm run deploy       # wrangler deploy
npm run test         # vitest
npm run cf-typegen   # regenerasi worker-configuration.d.ts
```

## Provider

- `mock`: VA fiktif, page simulasi di worker. Tanpa konfigurasi secret.
- `pakasir`: hit API `transactioncreate` / `transactiondetail` / `paymentsimulation`. Butuh `PAKASIR_PROJECT` + `PAKASIR_API_KEY`. Webhook masuk tanpa signature → diverifikasi cross-check `transactiondetail`.
- `sumopod`: hosted page (`POST /payments`), redirect customer ke `payment_url`. Butuh `SUMODOP_API_KEY`. Webhook diverifikasi `X-Webhook-Token` (`SUMODOP_WEBHOOK_TOKEN`) atau Svix signature (`SUMODOP_WEBHOOK_SECRET`). Tanpa endpoint simulate/status.
- Mode switch via `PAYMENT_PROVIDER` env. Default `mock`.

## Konvensi

- Plain `fetch` handler (`satisfies ExportedHandler<Env>`), tanpa framework.
- Semua response JSON berbentuk `{ success, message?, data? }`.
- Provider `create` mengembalikan `PaymentRecord` lengkap (payment_code / qr_string / total_payment / payment_method / expires_at / provider_data) — dipakai langsung FS-Public.
- Tab indentation, double quotes, trailing commas (sesuai `.prettierrc`).
- Nama test ASCII saja (hindari `→` dsb) agar tidak memicu warning header vitest.

## Keamanan

- `PAYMENT_WEBHOOK_SECRET` (webhook ke FS-Public) dan `PAKASIR_API_KEY` tidak boleh di-commit (pakai `.dev.vars` / `wrangler secret put`).
- Signature webhook = HMAC-SHA256 hex dari raw body. FS-Public verifikasi dengan secret yang sama.
- Jangan simpan secret di `wrangler.jsonc`.
- Endpoint sandbox (`/v1/payments/:id/pay|fail|simulate`) hanya untuk provider `mock`. Jika `SANDBOX_ADMIN_TOKEN` diset, wajib header `X-Payment-Admin-Token` (constant-time compare).
