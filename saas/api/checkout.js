const { requireAuth } = require("../lib/_auth");

const PACKS = [
  { id: "lite",  name: "Lite",  price_usd: 6,   credits: 20000,  tokens: "4M",   description: "Casual exploration", features: ["20,000 credits", "4M tokens", "Never expires", "All AI models"] },
  { id: "core",  name: "Core",  price_usd: 24,  credits: 80000,  tokens: "16M",  description: "Daily workflows", features: ["80,000 credits", "16M tokens", "Never expires", "All AI models", "Priority support"] },
  { id: "scale", name: "Scale", price_usd: 60,  credits: 200000, tokens: "40M",  description: "Complex tasks", features: ["200,000 credits", "40M tokens", "Never expires", "All AI models", "Priority support"] },
  { id: "max",   name: "Max",   price_usd: 150, credits: 500000, tokens: "100M", description: "Enterprise workloads", features: ["500,000 credits", "100M tokens", "Never expires", "All AI models", "Priority support"] },
];

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  
  const packId = req.query.pack;
  const pack = PACKS.find(p => p.id === packId);
  
  if (!pack) {
    return res.status(404).send("<h1>Pack not found</h1>");
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/x-icon" href="/favicon.ico">
<link rel="icon" type="image/png" href="/icon.png">
<title>Checkout — ${pack.name} Pack | TaskBolt</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: #fafafa;
  color: #1a1a1a;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.header {
  width: 100%;
  padding: 20px 32px;
  display: flex;
  align-items: center;
  gap: 10px;
  border-bottom: 1px solid #eee;
  background: white;
}
.header-logo {
  width: 36px; height: 36px;
  border-radius: 10px;
  object-fit: cover;
}
.header-title { font-weight: 700; font-size: 1.1rem; }
.header-sub { color: #888; font-size: 0.85rem; margin-left: auto; }
.container {
  max-width: 480px;
  width: 100%;
  padding: 40px 20px;
}
.card {
  background: white;
  border-radius: 16px;
  border: 1px solid #e5e5e5;
  overflow: hidden;
  box-shadow: 0 4px 24px rgba(0,0,0,0.06);
}
.card-header {
  padding: 28px 28px 20px;
  border-bottom: 1px solid #f0f0f0;
}
.pack-badge {
  display: inline-block;
  background: #f0f0f0;
  color: #555;
  font-size: 0.7rem;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 20px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 12px;
}
.pack-name { font-size: 1.5rem; font-weight: 700; margin-bottom: 4px; }
.pack-desc { color: #666; font-size: 0.9rem; }
.card-body { padding: 24px 28px; }
.price-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 20px;
}
.price { font-size: 2.2rem; font-weight: 800; }
.price-period { color: #888; font-size: 0.85rem; }
.features { list-style: none; margin-bottom: 24px; }
.features li {
  padding: 8px 0;
  font-size: 0.88rem;
  color: #444;
  display: flex;
  align-items: center;
  gap: 10px;
}
.features li::before {
  content: "✓";
  color: #22c55e;
  font-weight: 700;
  font-size: 0.9rem;
}
.divider { height: 1px; background: #f0f0f0; margin: 20px 0; }
.email-label { font-size: 0.78rem; color: #888; margin-bottom: 6px; display: block; }
.email-display {
  background: #f7f7f7;
  border: 1px solid #eee;
  border-radius: 10px;
  padding: 12px 16px;
  font-size: 0.88rem;
  color: #333;
  margin-bottom: 20px;
}
.pay-btn {
  width: 100%;
  padding: 16px;
  border: none;
  border-radius: 12px;
  background: linear-gradient(135deg, #1a1a2e, #16213e);
  color: white;
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  position: relative;
  overflow: hidden;
}
.pay-btn:hover { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(0,0,0,0.15); }
.pay-btn:active { transform: translateY(0); }
.pay-btn:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }
.pay-btn .spinner {
  display: inline-block;
  width: 18px; height: 18px;
  border: 2px solid rgba(255,255,255,0.3);
  border-top-color: white;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
  vertical-align: middle;
  margin-right: 8px;
}
@keyframes spin { to { transform: rotate(360deg); } }
.guarantee {
  text-align: center;
  margin-top: 16px;
  font-size: 0.78rem;
  color: #999;
}
.footer-note {
  text-align: center;
  margin-top: 24px;
  font-size: 0.75rem;
  color: #bbb;
}
.error-msg {
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 10px;
  padding: 12px 16px;
  color: #dc2626;
  font-size: 0.85rem;
  margin-bottom: 16px;
  display: none;
}
</style>
</head>
<body>
<div class="header">
  <img class="header-logo" src="/icon.png" alt="TaskBolt">
  <span class="header-title">TaskBolt</span>
  <span class="header-sub">Secure Checkout</span>
</div>
<div class="container">
  <div class="card">
    <div class="card-header">
      <span class="pack-badge">One-time purchase</span>
      <div class="pack-name">${pack.name} Pack</div>
      <div class="pack-desc">${pack.description}</div>
    </div>
    <div class="card-body">
      <div class="price-row">
        <span class="price">$${pack.price_usd}</span>
        <span class="price-period">one-time</span>
      </div>
      <ul class="features">
        ${pack.features.map(f => `<li>${f}</li>`).join("\n        ")}
      </ul>
      <div class="divider"></div>
      <div id="errorBox" class="error-msg"></div>
      <button id="payBtn" class="pay-btn" onclick="handlePay()">
        Pay $${pack.price_usd} — Secure Checkout
      </button>
      <p class="guarantee">🔒 Secured by Dodo Payments • Instant delivery</p>
    </div>
  </div>
  <p class="footer-note">Credits are added instantly after payment. No subscription, no recurring charges.</p>
</div>
<script>
let processing = false;
async function handlePay() {
  if (processing) return;
  processing = true;
  const btn = document.getElementById('payBtn');
  const errBox = document.getElementById('errorBox');
  errBox.style.display = 'none';
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Preparing payment...';
  
  // Get auth token from parent window or localStorage
  const token = localStorage.getItem('tb_auth_token') || new URLSearchParams(window.location.search).get('token');
  if (!token) {
    errBox.textContent = 'Not signed in. Please open TaskBolt desktop app and try again.';
    errBox.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Pay $${pack.price_usd} — Secure Checkout';
    processing = false;
    return;
  }
  
  try {
    const res = await fetch('https://taskbolt.space/api/billing?action=purchase', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pack_id: '${pack.id}' }),
    });
    const data = await res.json();
    if (data.ok && data.payment_url) {
      btn.innerHTML = '<span class="spinner"></span> Redirecting to payment...';
      window.location.href = data.payment_url;
    } else {
      errBox.textContent = data.error || 'Failed to create payment. Please try again.';
      errBox.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Pay $${pack.price_usd} — Secure Checkout';
      processing = false;
    }
  } catch (e) {
    errBox.textContent = 'Network error. Please check your connection and try again.';
    errBox.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Pay $${pack.price_usd} — Secure Checkout';
    processing = false;
  }
}
</script>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html");
  res.status(200).send(html);
};
