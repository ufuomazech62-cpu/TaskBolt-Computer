const { sql, initDB } = require("../_db");

const PAYSTACK_BASE = "https://api.paystack.co";

const PACKS = {
  starter:  { credits: 1000  },
  basic:    { credits: 4000  },
  standard: { credits: 10000 },
  pro:      { credits: 30000 },
  business: { credits: 70000 },
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
    const verifyResp = await fetch(`${PAYSTACK_BASE}/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${paystackKey}` },
    });
    const verifyData = await verifyResp.json();

    if (!verifyData.status || verifyData.data?.status !== "success") {
      return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:3rem;">
        <h2>Payment Failed</h2><p>Please try again.</p>
        <script>setTimeout(()=>window.close(),3000);</script></body></html>`);
    }

    const metadata = verifyData.data.metadata || {};
    const userId = metadata.user_id;
    const packId = metadata.pack_id;
    const txId = metadata.transaction_id;
    const pack = PACKS[packId];

    if (userId && packId && pack) {
      const existing = await sql`SELECT id FROM credits WHERE user_id = ${userId}::uuid`;
      if (existing.length === 0) {
        await sql`INSERT INTO credits (user_id, balance, total_allocated, total_used) VALUES (${userId}::uuid, ${pack.credits}, ${pack.credits}, 0)`;
      } else {
        await sql`UPDATE credits SET balance = balance + ${pack.credits}, total_allocated = total_allocated + ${pack.credits}, updated_at = NOW() WHERE user_id = ${userId}::uuid`;
      }
      if (txId) {
        await sql`UPDATE transactions SET status = 'completed', flutterwave_ref = ${reference} WHERE id = ${txId}::uuid`;
      }
    }

    return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:3rem;">
      <h2>Payment Successful!</h2><p><strong>${pack.credits.toLocaleString()}</strong> credits added to your account.</p>
      <p>You can close this window.</p>
      <script>setTimeout(()=>window.close(),3000);</script></body></html>`);
  } catch (e) {
    return res.status(500).send("Verification failed");
  }
};
