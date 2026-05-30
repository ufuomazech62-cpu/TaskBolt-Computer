const { sql, initDB } = require("../_db");

const PAYSTACK_BASE = "https://api.paystack.co";

const PLANS = {
  starter:    { price_usd: 6,   price_ngn: 9900,    credits_monthly: 5000,   daily: 0    },
  pro:        { price_usd: 20,  price_ngn: 33000,   credits_monthly: 20000,  daily: 200  },
  business:   { price_usd: 100, price_ngn: 165000,  credits_monthly: 100000, daily: 1000 },
  enterprise: { price_usd: 200, price_ngn: 330000,  credits_monthly: 200000, daily: 2000 },
};

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  await initDB();

  const { reference } = req.query;
  if (!reference) return res.status(400).send("Missing reference");

  const paystackKey = process.env.PAYSTACK_SECRET_KEY;
  if (!paystackKey) return res.status(500).send("Server error");

  try {
    // Verify transaction with Paystack
    const verifyResp = await fetch(`${PAYSTACK_BASE}/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${paystackKey}` },
    });
    const verifyData = await verifyResp.json();

    if (!verifyData.status || verifyData.data?.status !== "success") {
      return res.send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:3rem;">
          <h2>Payment Failed</h2>
          <p>Your payment was not successful. Please try again.</p>
          <script>setTimeout(()=>{ window.close(); }, 3000);</script>
        </body></html>
      `);
    }

    const metadata = verifyData.data.metadata || {};
    const userId = metadata.user_id;
    const planId = metadata.plan_id;
    const txId = metadata.transaction_id;
    const plan = PLANS[planId];

    if (userId && planId && plan) {
      // Activate subscription
      await sql`
        INSERT INTO subscriptions (user_id, plan, status, credits_monthly, credits_daily_bonus, price_usd, flutterwave_sub_id, ends_at)
        VALUES (${userId}::uuid, ${planId}, 'active', ${plan.credits_monthly}, ${plan.daily}, ${plan.price_usd}, ${reference}, NOW() + INTERVAL '30 days')
        ON CONFLICT DO NOTHING
      `;

      const existing = await sql`SELECT id FROM credits WHERE user_id = ${userId}::uuid`;
      if (existing.length === 0) {
        await sql`
          INSERT INTO credits (user_id, balance, total_allocated, total_used, daily_bonus_amount, last_daily_claim)
          VALUES (${userId}::uuid, ${plan.credits_monthly}, ${plan.credits_monthly}, 0, ${plan.daily}, NULL)
        `;
      } else {
        await sql`
          UPDATE credits SET
            balance = balance + ${plan.credits_monthly},
            total_allocated = total_allocated + ${plan.credits_monthly},
            daily_bonus_amount = ${plan.daily},
            updated_at = NOW()
          WHERE user_id = ${userId}::uuid
        `;
      }

      if (txId) {
        await sql`
          UPDATE transactions SET status = 'completed', flutterwave_ref = ${reference}, created_at = NOW()
          WHERE id = ${txId}::uuid
        `;
      }
    }

    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:3rem;">
        <h2>Payment Successful!</h2>
        <p>Your <strong>${planId}</strong> plan is now active.</p>
        <p>You can close this window.</p>
        <script>setTimeout(()=>{ window.close(); }, 3000);</script>
      </body></html>
    `);
  } catch (e) {
    return res.status(500).send("Verification failed: " + e.message);
  }
};
