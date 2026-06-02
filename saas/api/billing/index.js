const crypto = require("crypto");
const { requireAuth, jsonResponse } = require("../_auth");
const { sql, initDB } = require("../_db");
const { sendPaymentEmail } = require("../_email");

const DODO_API = process.env.DODO_API_URL || "https://api.dodopayments.com";
const SAAS_URL = "https://taskbolt.space";

// One-time credit packs (4 tiers, pay-as-you-go)
// 1 credit = 200 tokens
const PACKS = [
  { id: "lite",  name: "Lite",  price_usd: 6,   price_cents: 600,   credits: 5000,   tokens: 1000000,  description: "1M tokens - Casual exploration" },
  { id: "core",  name: "Core",  price_usd: 24,  price_cents: 2400,  credits: 25000,  tokens: 5000000,  description: "5M tokens - Daily workflows" },
  { id: "scale", name: "Scale", price_usd: 60,  price_cents: 6000,  credits: 75000,  tokens: 15000000, description: "15M tokens - Complex tasks" },
  { id: "max",   name: "Max",   price_usd: 150, price_cents: 15000, credits: 200000, tokens: 40000000, description: "40M tokens - Enterprise workloads" },
];

const PACKS_MAP = Object.fromEntries(PACKS.map(p => [p.id, { credits: p.credits }]));

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  const action = req.query.action || (req.method === "GET" ? "status" : "unknown");
  await initDB();

  // --- PACKS (GET ?action=packs) ---
  if (action === "packs" && req.method === "GET") {
    const user = requireAuth(req);
    if (!user) return jsonResponse(res, { error: "Unauthorized" }, 401);
    const dodoProducts = await sql`SELECT pack_id, dodo_product_id FROM dodo_products`;
    const productMap = {};
    dodoProducts.forEach(p => { productMap[p.pack_id] = p.dodo_product_id; });
    const packs = PACKS.map(p => ({ ...p, dodo_product_id: productMap[p.id] || null, available: !!productMap[p.id] }));
    return jsonResponse(res, { ok: true, packs });
  }

  // --- STATUS (GET ?action=status) ---
  if (action === "status" && req.method === "GET") {
    const user = requireAuth(req);
    if (!user) return jsonResponse(res, { error: "Unauthorized" }, 401);
    const cred = await sql`SELECT balance, total_allocated, total_used FROM credits WHERE user_id = ${user.id}::uuid`;
    const credits = cred[0] || { balance: 0, total_allocated: 0, total_used: 0 };
    const todayUsage = await sql`SELECT COALESCE(SUM(total_tokens),0) as tokens, COALESCE(SUM(credits_deducted),0) as credits FROM usage_logs WHERE user_id = ${user.id}::uuid AND created_at >= CURRENT_DATE`;
    const monthUsage = await sql`SELECT COALESCE(SUM(total_tokens),0) as tokens, COALESCE(SUM(credits_deducted),0) as credits FROM usage_logs WHERE user_id = ${user.id}::uuid AND created_at >= DATE_TRUNC('month', CURRENT_DATE)`;
    const transactions = await sql`SELECT credits, amount_ngn as amount_usd, status, type, created_at FROM transactions WHERE user_id = ${user.id}::uuid ORDER BY created_at DESC LIMIT 5`;
    return jsonResponse(res, {
      ok: true,
      credits: { balance: credits.balance, total_allocated: credits.total_allocated, total_used: credits.total_used },
      usage: {
        today: { tokens: Number(todayUsage[0]?.tokens||0), credits: Number(todayUsage[0]?.credits||0) },
        this_month: { tokens: Number(monthUsage[0]?.tokens||0), credits: Number(monthUsage[0]?.credits||0) }
      },
      transactions: transactions.map(t => ({ credits: t.credits, amount_usd: t.amount_usd ? Number(t.amount_usd) : null, status: t.status, type: t.type, created_at: t.created_at })),
      rateLimited: credits.balance <= 0,
    });
  }

  // --- CHECK (GET ?action=check) — fast rate limit check ---
  if (action === "check" && req.method === "GET") {
    const user = requireAuth(req);
    if (!user) return jsonResponse(res, { error: "Unauthorized" }, 401);
    const cred = await sql`SELECT balance FROM credits WHERE user_id = ${user.id}::uuid`;
    const balance = cred[0]?.balance || 0;
    return jsonResponse(res, { ok: true, balance, rateLimited: balance <= 0 });
  }

  // --- USAGE (GET ?action=usage) ---
  if (action === "usage" && req.method === "GET") {
    const user = requireAuth(req);
    if (!user) return jsonResponse(res, { error: "Unauthorized" }, 401);
    const period = req.query.period || "month";
    let dateFilter = sql`created_at >= DATE_TRUNC('month', CURRENT_DATE)`;
    if (period === "today") dateFilter = sql`created_at >= CURRENT_DATE`;
    else if (period === "week") dateFilter = sql`created_at >= CURRENT_DATE - INTERVAL '7 days'`;
    const stats = await sql`SELECT COALESCE(SUM(prompt_tokens),0) as prompt_tokens, COALESCE(SUM(completion_tokens),0) as completion_tokens, COALESCE(SUM(total_tokens),0) as total_tokens, COALESCE(SUM(credits_deducted),0) as credits_used, COUNT(*) as requests FROM usage_logs WHERE user_id = ${user.id}::uuid AND ${dateFilter}`;
    const models = await sql`SELECT model, SUM(total_tokens) as tokens, SUM(credits_deducted) as credits, COUNT(*) as requests FROM usage_logs WHERE user_id = ${user.id}::uuid AND ${dateFilter} GROUP BY model ORDER BY tokens DESC`;
    const transactions = await sql`SELECT type, plan, amount_ngn as amount_usd, credits, status, created_at FROM transactions WHERE user_id = ${user.id}::uuid ORDER BY created_at DESC LIMIT 20`;
    return jsonResponse(res, { ok: true, period, stats: { prompt_tokens: Number(stats[0]?.prompt_tokens||0), completion_tokens: Number(stats[0]?.completion_tokens||0), total_tokens: Number(stats[0]?.total_tokens||0), credits_used: Number(stats[0]?.credits_used||0), requests: Number(stats[0]?.requests||0) }, models: models.map(m => ({ model: m.model, tokens: Number(m.tokens), credits: Number(m.credits), requests: Number(m.requests) })), transactions: transactions.map(t => ({ type: t.type, plan: t.plan, amount_usd: t.amount_usd ? Number(t.amount_usd) : null, credits: t.credits, status: t.status, created_at: t.created_at })) });
  }

  // --- PURCHASE (POST ?action=purchase) --- works for both packs and topups
  if (action === "purchase" && req.method === "POST") {
    const user = requireAuth(req);
    if (!user) return jsonResponse(res, { error: "Unauthorized" }, 401);
    const { pack_id } = req.body || {};
    const item = PACKS.find(p => p.id === pack_id);
    if (!item) return jsonResponse(res, { error: "Invalid pack" }, 400);
    const dodoKey = process.env.DODO_PAYMENTS_API_KEY;
    if (!dodoKey) return jsonResponse(res, { error: "Payment system not configured" }, 500);
    const prod = await sql`SELECT dodo_product_id FROM dodo_products WHERE pack_id = ${pack_id}`;
    if (!prod.length || !prod[0].dodo_product_id) return jsonResponse(res, { error: "Pack not available" }, 400);
    const tx = await sql`INSERT INTO transactions (user_id, type, credits, amount_ngn, status, metadata) VALUES (${user.id}::uuid, 'purchase', ${item.credits}, ${item.price_usd}, 'pending', ${JSON.stringify({ pack_id, provider: 'dodo' })}::jsonb) RETURNING id`;
    const txId = tx[0].id;
    try {
      const resp = await fetch(`${DODO_API}/checkouts`, { method: "POST", headers: { "Authorization": `Bearer ${dodoKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ product_cart: [{ product_id: prod[0].dodo_product_id, quantity: 1 }], customer: { email: user.email || "user@taskbolt.com" }, returnURL: `${SAAS_URL}/api/billing?action=callback`, cancelURL: `${SAAS_URL}/api/billing?action=callback&cancelled=true`, metadata: { user_id: user.id, pack_id, transaction_id: txId, credits: item.credits.toString() }, minimalAddress: true, featureFlags: { allowPhoneNumberCollection: false, requirePhoneNumber: false, allowCustomerEditingCity: false, allowCustomerEditingStreet: false, allowCustomerEditingZipcode: false, allowCustomerEditingCountry: false, allowCustomerEditingState: false, allowCustomerEditingName: false, allowCustomerEditingEmail: false, allowCustomerEditingBusinessName: false, allowCustomerEditingTaxID: false } }) });
      const data = await resp.json();
      if (!data.session_id || !data.checkout_url) { await sql`UPDATE transactions SET status='failed' WHERE id=${txId}::uuid`; return jsonResponse(res, { error: data.message || "Checkout failed" }, 400); }
      return jsonResponse(res, { ok: true, payment_url: data.checkout_url, session_id: data.session_id, pack: pack_id, credits: item.credits, amount_usd: item.price_usd });
    } catch (e) {
      await sql`UPDATE transactions SET status='error', metadata=${JSON.stringify({error:e.message})}::jsonb WHERE id=${txId}::uuid`;
      return jsonResponse(res, { error: "Payment service unavailable" }, 502);
    }
  }

  // --- WEBHOOK (POST ?action=webhook) ---
  if (action === "webhook" && req.method === "POST") {
    try {
      const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      const webhookSecret = process.env.DODO_PAYMENTS_WEBHOOK_KEY || "";
      if (webhookSecret) {
        const wid = req.headers["webhook-id"] || "", wts = req.headers["webhook-timestamp"] || "", wsig = req.headers["webhook-signature"] || "";
        if (!wid || !wts || !wsig) return res.status(401).json({ error: "Missing headers" });
        const ts = parseInt(wts, 10);
        if (Math.abs(Math.floor(Date.now()/1000) - ts) > 300) return res.status(401).json({ error: "Expired" });
        const sk = webhookSecret.startsWith("whsec_") ? webhookSecret.slice(6) : webhookSecret;
        const sb = Buffer.from(sk, "base64");
        const sc = `${wid}.${wts}.${rawBody}`;
        const exp = `v1 ${crypto.createHmac("sha256", sb).update(sc).digest("base64")}`;
        if (!wsig.split(" ").some(s => s.trim() === exp)) return res.status(401).json({ error: "Invalid signature" });
      }
      const event = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      console.log("[webhook] event type:", event.type, "data:", JSON.stringify(event).slice(0, 500));
      if (event.type !== "payment.succeeded") return res.status(200).json({ ok: true, message: "Ignored" });
      const pd = event.data || {};
      const meta = pd.metadata || event.metadata || {};
      const userId = meta.user_id, packId = meta.pack_id, txId = meta.transaction_id;
      const creditsStr = meta.credits;
      const paymentId = pd.payment_id || event.payment_id;
      if (!userId || !packId) return res.status(200).json({ ok: true, message: "No metadata" });
      const item = PACKS_MAP[packId];
      const credits = creditsStr ? parseInt(creditsStr, 10) : (item ? item.credits : 0);
      if (!credits) return res.status(200).json({ ok: true, message: "Invalid credits" });
      // Check if already processed
      if (txId) {
        try {
          const ex = await sql`SELECT status FROM transactions WHERE id=${txId}::uuid`;
          if (ex.length && ex[0].status === "completed") return res.status(200).json({ ok: true, message: "Already processed" });
        } catch (e) { console.error("[webhook] tx check error:", e.message); }
      }
      // Add credits
      const existing = await sql`SELECT id FROM credits WHERE user_id=${userId}::uuid`;
      if (existing.length === 0) {
        await sql`INSERT INTO credits (user_id, balance, total_allocated, total_used) VALUES (${userId}::uuid, ${credits}, ${credits}, 0)`;
      } else {
        await sql`UPDATE credits SET balance=balance+${credits}, total_allocated=total_allocated+${credits}, updated_at=NOW() WHERE user_id=${userId}::uuid`;
      }
      // Mark transaction complete
      if (txId) {
        try { await sql`UPDATE transactions SET status='completed', flutterwave_ref=${paymentId||'dodo-'+Date.now()} WHERE id=${txId}::uuid`; } catch (e) { console.error("[webhook] tx update error:", e.message); }
      }
      console.log(`[webhook] SUCCESS: added ${credits} credits to user ${userId}`);

      // Send payment confirmation email (async, don't block response)
      try {
        const userRow = await sql`SELECT email, display_name FROM users WHERE id = ${userId}::uuid LIMIT 1`;
        if (userRow.length && userRow[0].email) {
          const pack = PACKS.find(p => p.id === packId);
          const packName = pack ? pack.name : packId;
          const amount = pack ? pack.price_usd : 0;
          sendPaymentEmail(userRow[0].email, { packName, credits, amount }).catch(e => console.error("[webhook] Payment email failed:", e.message));
        }
      } catch (e) { console.error("[webhook] Payment email lookup failed:", e.message); }

      return res.status(200).json({ ok: true, message: `Credits added: ${credits}` });
    } catch (err) {
      console.error("[webhook] FATAL:", err.message, err.stack);
      return res.status(500).json({ error: "Webhook processing failed", detail: err.message });
    }
  }

  // --- CALLBACK (GET ?action=callback) ---
  if (action === "callback" && req.method === "GET") {
    const { cancelled } = req.query;
    if (cancelled === "true") return res.setHeader("Content-Type", "text/html").status(200).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cancelled | TaskBolt</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#fafafa;color:#1a1a1a;text-align:center}.c{padding:3rem;border-radius:20px;background:white;border:1px solid #e5e5e5;box-shadow:0 4px 24px rgba(0,0,0,.06);max-width:400px;width:90%}.logo{font-size:2rem;margin-bottom:1rem}h2{font-size:1.3rem;margin-bottom:.5rem;color:#666}p{color:#999;font-size:.9rem;margin-top:.5rem}.btn{display:inline-block;margin-top:1.5rem;padding:12px 24px;background:#f0f0f0;border:none;border-radius:10px;color:#333;font-weight:600;cursor:pointer;text-decoration:none;font-size:.88rem}.btn:hover{background:#e5e5e5}</style></head><body><div class="c"><div class="logo">⚡</div><h2>Payment Cancelled</h2><p>No charges were made. You can close this tab.</p><a class="btn" href="#" onclick="window.close()">Close Tab</a></div></body></html>`);
    return res.setHeader("Content-Type", "text/html").status(200).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment Successful | TaskBolt</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#fafafa;color:#1a1a1a;text-align:center}.c{padding:3rem;border-radius:20px;background:white;border:1px solid #e5e5e5;box-shadow:0 4px 24px rgba(0,0,0,.06);max-width:420px;width:90%}.logo{font-size:2rem;margin-bottom:1rem}.check{width:56px;height:56px;border-radius:50%;background:#f0fdf4;border:2px solid #22c55e;display:flex;align-items:center;justify-content:center;margin:0 auto 1rem;font-size:1.5rem}h2{font-size:1.3rem;color:#16a34a;margin-bottom:.5rem}p{color:#666;font-size:.9rem;margin:.3rem 0}.status{margin-top:1.5rem;padding:12px;background:#f7f7f7;border-radius:10px;font-size:.82rem;color:#888}.sp{width:20px;height:20px;border:2px solid #e5e5e5;border-top-color:#22c55e;border-radius:50%;animation:s .8s linear infinite;margin:0 auto .5rem}@keyframes s{to{transform:rotate(360deg)}}.btn{display:inline-block;margin-top:1.5rem;padding:12px 24px;background:linear-gradient(135deg,#1a1a2e,#16213e);border:none;border-radius:10px;color:white;font-weight:600;cursor:pointer;text-decoration:none;font-size:.88rem}.btn:hover{opacity:.9}</style></head><body><div class="c"><div class="logo">⚡</div><div class="check">✓</div><h2>Payment Successful!</h2><p>Your credits are being added to your account.</p><div class="status"><div class="sp"></div>Credits will appear in TaskBolt shortly.<br>You can close this tab.</div><a class="btn" href="#" onclick="window.close()">Done — Close Tab</a></div></body></html>`);
  }

  // --- INIT PRODUCTS (POST ?action=init) ---
  if (action === "init" && req.method === "POST") {
    const auth = req.headers["authorization"] || "";
    const adminSecret = process.env.ADMIN_SECRET || "taskbolt-admin-2026";
    const dodoKey = process.env.DODO_PAYMENTS_API_KEY;
    if (auth !== `Bearer ${adminSecret}` && auth !== `Bearer ${dodoKey}`) return jsonResponse(res, { error: "Unauthorized" }, 401);
    if (!dodoKey) return jsonResponse(res, { error: "DODO_PAYMENTS_API_KEY not configured" }, 500);
    await sql`CREATE TABLE IF NOT EXISTS dodo_products (pack_id TEXT PRIMARY KEY, dodo_product_id TEXT NOT NULL, name TEXT, price_cents INTEGER, created_at TIMESTAMP DEFAULT NOW())`;
    // Force mode: clear old products and recreate
    const force = req.query.force === "true" || req.body?.force === true;
    if (force) {
      await sql`DELETE FROM dodo_products`;
      console.log("[init] Cleared all existing products (force mode)");
    }
    const allItems = PACKS;
    const results = [];
    for (const item of allItems) {
      if (!force) {
        const existing = await sql`SELECT dodo_product_id FROM dodo_products WHERE pack_id = ${item.id}`;
        if (existing.length) { results.push({ pack_id: item.id, dodo_product_id: existing[0].dodo_product_id, status: "exists" }); continue; }
      }
      try {
        const resp = await fetch(`${DODO_API}/products`, { method: "POST", headers: { "Authorization": `Bearer ${dodoKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ name: `TaskBolt ${item.name} - ${item.credits.toLocaleString()} Credits`, description: `${item.description}. One-time credit pack for TaskBolt AI Desktop Agent.`, tax_category: "digital_products", price: { currency: "USD", discount: 0, price: item.price_cents, purchasing_power_parity: false, type: "one_time_price" }, metadata: { pack_id: item.id, credits: item.credits.toString(), source: "taskbolt" } }) });
        const data = await resp.json();
        const pid = data.product_id || data.id;
        if (pid) { await sql`INSERT INTO dodo_products (pack_id, dodo_product_id, name, price_cents) VALUES (${item.id}, ${pid}, ${item.name}, ${item.price_cents}) ON CONFLICT (pack_id) DO UPDATE SET dodo_product_id = ${pid}`; results.push({ pack_id: item.id, dodo_product_id: pid, status: "created" }); }
        else { results.push({ pack_id: item.id, error: data.message || "Unknown", status: "failed" }); }
      } catch (e) { results.push({ pack_id: item.id, error: e.message, status: "error" }); }
    }
    return jsonResponse(res, { ok: results.every(r => r.status !== "failed" && r.status !== "error"), results });
  }

  return jsonResponse(res, { error: "Unknown action" }, 400);
};
