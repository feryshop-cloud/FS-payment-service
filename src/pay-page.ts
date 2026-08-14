import type { PaymentRecord } from "./types";

function esc(value: unknown): string {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function formatRupiah(amount: number): string {
	return new Intl.NumberFormat("id-ID", {
		style: "currency",
		currency: "IDR",
		maximumFractionDigits: 0,
	}).format(amount);
}

export function renderPayPage(record: PaymentRecord, origin: string): string {
	const expiresMs = record.expires_at;
	const statusLabel: Record<string, string> = {
		pending: "Menunggu Pembayaran",
		paid: "Pembayaran Berhasil",
		failed: "Pembayaran Gagal",
		expired: "Pembayaran Kadaluarsa",
	};
	const statusColor: Record<string, string> = {
		pending: "#f59e0b",
		paid: "#22c55e",
		failed: "#ef4444",
		expired: "#6b7280",
	};

	const customerLine = record.customer?.name
		? `<div class="row"><span>Pembeli</span><strong>${esc(record.customer.name)}</strong></div>`
		: "";
	const descriptionLine = record.description
		? `<div class="row"><span>Keterangan</span><strong>${esc(record.description)}</strong></div>`
		: "";
	const returnLink = record.return_url
		? `<a class="btn btn-ghost" href="${esc(record.return_url)}">Kembali ke Invoice</a>`
		: "";

	return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Payment — ${esc(record.order_id)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .card { background: #1e293b; border: 1px solid #334155; border-radius: 16px; max-width: 460px; width: 100%; overflow: hidden; box-shadow: 0 20px 40px rgba(0,0,0,.4); }
  .banner { background: linear-gradient(90deg, #7c3aed, #4f46e5); color: #fff; text-align: center; padding: 10px; font-size: 12px; font-weight: 700; letter-spacing: .5px; text-transform: uppercase; }
  .body { padding: 24px; }
  h1 { font-size: 18px; margin-bottom: 4px; }
  .sub { color: #94a3b8; font-size: 13px; margin-bottom: 20px; }
  .status { display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 999px; font-size: 13px; font-weight: 600; margin-bottom: 20px; }
  .status .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
  .rows { border-top: 1px solid #334155; padding-top: 16px; }
  .row { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; font-size: 14px; }
  .row span { color: #94a3b8; }
  .row strong { text-align: right; word-break: break-word; }
  .va { background: #0f172a; border: 1px dashed #475569; border-radius: 10px; padding: 14px; margin: 16px 0; text-align: center; }
  .va .label { font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px; }
  .va .number { font-size: 22px; font-weight: 800; letter-spacing: 2px; font-variant-numeric: tabular-nums; margin-top: 4px; }
  .countdown { text-align: center; font-size: 13px; color: #f59e0b; margin-bottom: 16px; font-variant-numeric: tabular-nums; }
  .actions { display: flex; flex-direction: column; gap: 10px; margin-top: 20px; }
  .btn { display: block; width: 100%; text-align: center; padding: 12px; border-radius: 10px; font-size: 14px; font-weight: 700; cursor: pointer; border: none; text-decoration: none; }
  .btn-primary { background: #22c55e; color: #052e16; }
  .btn-primary:hover { background: #16a34a; }
  .btn-danger { background: #ef4444; color: #450a0a; }
  .btn-danger:hover { background: #dc2626; }
  .btn-ghost { background: transparent; color: #94a3b8; border: 1px solid #334155; }
  .btn-ghost:hover { color: #e2e8f0; border-color: #475569; }
  .btn:disabled { opacity: .5; cursor: not-allowed; }
  .flash { display: none; margin-top: 12px; padding: 10px; border-radius: 8px; font-size: 13px; text-align: center; }
  .flash.ok { display: block; background: rgba(34,197,94,.15); color: #4ade80; }
  .flash.err { display: block; background: rgba(239,68,68,.15); color: #f87171; }
  .foot { margin-top: 20px; font-size: 11px; color: #475569; text-align: center; }
</style>
</head>
<body>
<div class="card">
  <div class="banner">Sandbox • Payment Service</div>
  <div class="body">
    <h1>Pembayaran ${esc(record.order_id)}</h1>
    <div class="sub">Simulasikan pembayaran untuk menguji alur pembayaran end-to-end.</div>
    <div class="status" id="status" style="color:${statusColor[record.status] || "#f59e0b"}">
      <span class="dot"></span><span id="statusText">${statusLabel[record.status] || record.status}</span>
    </div>
    <div class="rows">
      <div class="row"><span>Order ID</span><strong>${esc(record.order_id)}</strong></div>
      ${descriptionLine}
      ${customerLine}
      <div class="row"><span>Total</span><strong>${formatRupiah(record.amount)}</strong></div>
    </div>
    <div class="va">
      <div class="label">Nomor Virtual Account</div>
      <div class="number">${esc(record.payment_code)}</div>
    </div>
    <div class="countdown" id="countdown">Menghitung waktu…</div>
    <div class="actions">
      <button class="btn btn-primary" id="btnPay">Bayar Sekarang (Simulasikan Sukses)</button>
      <button class="btn btn-danger" id="btnFail">Tandai Gagal</button>
      ${returnLink}
    </div>
    <div class="flash" id="flash"></div>
    <div class="foot">Halaman ini hanya simulasi. Tidak ada uang yang benar-benar berpindah.</div>
  </div>
</div>
<script>
(function () {
  var paymentId = ${JSON.stringify(record.id)};
  var api = ${JSON.stringify(origin)};
  var returnUrl = ${JSON.stringify(record.return_url || null)};
  var expiresAt = ${record.expires_at};
  var currentStatus = ${JSON.stringify(record.status)};
  var btnPay = document.getElementById("btnPay");
  var btnFail = document.getElementById("btnFail");
  var statusEl = document.getElementById("status");
  var statusText = document.getElementById("statusText");
  var countdownEl = document.getElementById("countdown");
  var flashEl = document.getElementById("flash");

  var statusLabels = { pending: "Menunggu Pembayaran", paid: "Pembayaran Berhasil", failed: "Pembayaran Gagal", expired: "Pembayaran Kadaluarsa" };
  var statusColors = { pending: "#f59e0b", paid: "#22c55e", failed: "#ef4444", expired: "#6b7280" };

  function flash(msg, ok) {
    flashEl.className = "flash " + (ok ? "ok" : "err");
    flashEl.textContent = msg;
    setTimeout(function () { flashEl.className = "flash"; }, 3500);
  }

  function setStatus(status) {
    currentStatus = status;
    statusEl.style.color = statusColors[status] || "#f59e0b";
    statusText.textContent = statusLabels[status] || status;
    var done = status !== "pending";
    btnPay.disabled = done;
    btnFail.disabled = done;
    if (done) countdownEl.textContent = "";
  }

  function tick() {
    var diff = expiresAt - Date.now();
    if (diff <= 0) {
      countdownEl.textContent = "Waktu pembayaran habis.";
      return;
    }
    var s = Math.floor(diff / 1000);
    var m = Math.floor(s / 60); s = s % 60;
    var h = Math.floor(m / 60); m = m % 60;
    countdownEl.textContent = "Sisa waktu: " + (h ? h + "j " : "") + m + "m " + s + "s";
  }

  async function post(action) {
    try {
      var res = await fetch(api + "/v1/payments/" + encodeURIComponent(paymentId) + "/" + action, { method: "POST" });
      var json = await res.json();
      if (!res.ok || !json.success) { flash(json.message || "Gagal memproses.", false); return; }
      flash(json.message || "Berhasil.", true);
      setStatus(json.data.status);
      if (json.data.status === "paid" && returnUrl) { setTimeout(function () { window.location.href = returnUrl; }, 1200); }
      if (json.data.status !== "pending") stopPolling();
    } catch (e) { flash("Terjadi kesalahan jaringan.", false); }
  }

  btnPay.addEventListener("click", function () { post("pay"); });
  btnFail.addEventListener("click", function () { post("fail"); });

  var pollTimer = setInterval(async function () {
    try {
      var res = await fetch(api + "/v1/payments/" + encodeURIComponent(paymentId));
      var json = await res.json();
      if (json.success && json.data.status !== currentStatus) {
        setStatus(json.data.status);
        if (json.data.status === "paid" && returnUrl) { window.location.href = returnUrl; }
        if (json.data.status !== "pending") stopPolling();
      }
      if (json.data.status === "expired") setStatus("expired");
    } catch (e) {}
  }, 3000);

  function stopPolling() { clearInterval(pollTimer); }
  setInterval(tick, 1000);
  tick();
  setStatus(currentStatus);
})();
</script>
</body>
</html>`;
}
