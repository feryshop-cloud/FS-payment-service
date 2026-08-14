# Payment Service (Cloudflare Worker)

Payment gateway abstraction standalone (terpisah dari FS-Public & terpisah secara network).
Satu-satunya tempat adapter provider: `mock` (simulasi) dan `pakasir`. FS-Public hanya berbicara ke worker ini via interface seragam.

- State tersimpan di Cloudflare KV (`PAYMENTS`).
- Provider aktif dikontrol `PAYMENT_PROVIDER` (default `mock`).
- Webhook dikirim ke `callback_url` (FS-Public) dengan signature HMAC-SHA256.
- Cron tiap menit: menandai payment expired + reconcile provider eksternal + retry webhook yang gagal.

## Endpoints

| Method | Path                        | Fungsi                                                                                |
| ------ | --------------------------- | ------------------------------------------------------------------------------------- |
| `POST` | `/v1/payments`              | Buat payment intent (body: `order_id`, `amount`, `callback_url`, ...)                 |
| `GET`  | `/v1/payments/:id`          | Polling status (lazy-expire saat lewat batas waktu)                                   |
| `POST` | `/v1/payments/:id/pay`      | Sandbox quick action (mock) — pembayaran sukses                                       |
| `POST` | `/v1/payments/:id/fail`     | Sandbox quick action (mock) — pembayaran gagal                                        |
| `POST` | `/v1/payments/:id/simulate` | Simulasi via provider aktif (mock: tandai paid; pakasir sandbox: `paymentsimulation`) |
| `POST` | `/webhooks/pakasir`         | Webhook masuk dari Pakasir (tanpa signature → cross-check `transactiondetail`)        |
| `GET`  | `/p/:id`                    | Halaman payment (UI simulasi, mock provider)                                          |
| `GET`  | `/admin`                    | Daftar semua payment (debug)                                                          |
| `GET`  | `/health`                   | Health check                                                                          |

Status payment: `pending` → `paid` | `failed` | `expired`.

## Provider

| Provider  | Konfigurasi                          | Catatan                                                                                                                        |
| --------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `mock`    | —                                    | VA fiktif, page simulasi di worker. `payment_url` diisi `/p/{id}`                                                              |
| `pakasir` | `PAKASIR_PROJECT`, `PAKASIR_API_KEY` | QRIS/VA asli via API. `qr_string` (QRIS) / `payment_code` (VA), `total_payment` = amount + fee. Tanpa `payment_url` (API mode) |

Response create (normalisasi, dipakai langsung FS-Public):
`payment_id`, `order_id`, `provider`, `status`, `amount`, `currency`, `payment_code`, `payment_code_display`, `qr_string`, `total_payment`, `fee`, `payment_method`, `payment_url`, `expires_at`, `created_at`, `paid_at`.

## Webhook (ke FS-Public)

Saat status berubah, worker POST ke `callback_url` (dikirim saat create payment):

```
POST {callback_url}
Headers:
  x-payment-signature:  hex HMAC-SHA256(rawBody, secret)
  x-payment-event:      payment.paid | payment.failed | payment.expired
  x-payment-idempotency: event_id (untuk dedupe)
Body:
  {
    "event": "payment.paid",
    "event_id": "...",
    "payment_id": "...",
    "order_id": "...",
    "status": "paid",
    "amount": 50000,
    "currency": "IDR",
    "payment_code": "880...",
    "paid_at": "...",
    "timestamp": "..."
  }
```

`x-mock-signature` / `x-mock-event` / `x-mock-idempotency` tetap diterima sebagai alias kompat mundur.
Delivery retry via cron sampai `MAX_WEBHOOK_ATTEMPTS` (default 5), lalu dibuang.

## Webhook (dari Pakasir)

Pakasir mengirim `POST /webhooks/pakasir` tanpa signature → worker cross-check `GET /api/transactiondetail`.
Status `completed` → update paid + forward ke FS-Public. Status belum final → ack tanpa apply.

## Konfigurasi

`.dev.vars` (lokal) atau secret `wrangler secret put` (production):

| Variabel                 | Keterangan                                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `PAYMENT_WEBHOOK_SECRET` | Secret bersama dgn FS-Public utk verifikasi signature webhook (alias lama `MOCK_PAYMENT_WEBHOOK_SECRET` tetap dibaca) |
| `PAKASIR_API_KEY`        | API key Pakasir (dibutuhkan saat `PAYMENT_PROVIDER=pakasir`)                                                          |

`wrangler.jsonc` vars:

| Variabel                     | Default                   | Keterangan                                  |
| ---------------------------- | ------------------------- | ------------------------------------------- |
| `PAYMENT_PROVIDER`           | `mock`                    | Provider aktif: `mock` / `pakasir`          |
| `PAKASIR_PROJECT`            | —                         | Project Pakasir                             |
| `PAKASIR_METHOD`             | `qris`                    | Metode: `qris` / `bni_va` / dsb             |
| `PAKASIR_SANDBOX`            | `true`                    | Mode sandbox (aktifkan `paymentsimulation`) |
| `PAKASIR_BASE_URL`           | `https://app.pakasir.com` | Base URL API Pakasir                        |
| `DEFAULT_EXPIRES_IN_SECONDS` | `300`                     | Masa berlaku payment default (5 menit)      |
| `MAX_WEBHOOK_ATTEMPTS`       | `5`                       | Batas retry webhook                         |
| `ALLOWED_ORIGINS`            | `*`                       | CORS origin (dipisah koma)                  |

KV namespace `PAYMENTS` perlu dibuat dulu:

```
npx wrangler kv namespace create PAYMENTS
# lalu isi id & preview_id di wrangler.jsonc
```

## Menjalankan

```
npm install
npm run dev        # wrangler dev di http://localhost:8787
npm run test       # vitest (pool workers)
npm run cf-typegen # regenerasi worker-configuration.d.ts
```

Contoh create payment (default local):

```bash
curl -X POST http://localhost:8787/v1/payments \
  -H "Content-Type: application/json" \
  -d '{"order_id":"TSON-123456","amount":50000,"callback_url":"http://localhost:3000/api/webhooks/payment","return_url":"http://localhost:3000/invoices/TSON-123456"}'
```

Provider mock: buka `payment_url` untuk halaman simulasi. Provider pakasir: gunakan `POST /v1/payments/:id/simulate` (sandbox) untuk uji sukses.
