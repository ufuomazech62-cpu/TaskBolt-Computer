const crypto = require("crypto");
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
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  await initDB();

  const secret = process.env.PAYSTACK_SECRET_KEY || "";
  if (secret) {
    const signature = req.headers["x-paystack-signature"] || "";
    const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    const hash = crypto.createHmac("sha512", secret).update(rawBody).digest("hex");
    if (signature !== hash) {
      return res.status(401).json({ error: "Invalid signature" });
    }
  }

  const event = req.body;
  if (event?.event !== "charge.success") {
    return res.status(200).json({ ok: true, message: "Ignored" });
  }

  const data = event.data;
  const metadata = data.metadata || {};
  const userId = metadata.user_id;
  const packId = metadata.pack_id;
  const txId = metadata.transaction_id;
  const reference = data.reference;

  if (!userId || !packId) {
    return res.status(200).json({ ok: true, message: "No metadata" });
  }

  const pack = PACKS[packId];
  if (!pack) return res.status(200).json({ ok: true, message: "Invalid pack" });

  // Verify with Paystack
  const paystackKey = process.env.PAYSTACK_SECRET_KEY;
  if (paystackKey) {
    try {
      const verifyResp = await fetch(`${PAYSTACK_BASE}/transaction/verify/${reference}`, {
        headers: { Authorization: `Bearer ${paystackKey}` },
      });
      const verifyData = await verifyResp.json();
      if (!verifyData.status || verifyData.data?.status !== "success") {
        return res.status(200).json({ ok: true, message: "Verification failed" });
      }
    } catch {}
  }

  // Allocate credits
  const existing = await sql`SELECT id FROM credits WHERE user_id = ${userId}::uuid`;
  if (existing.length === 0) {
    await sql`
      INSERT INTO credits (user_id, balance, total_allocated, total_used)
      VALUES (${userId}::uuid, ${pack.credits}, ${pack.credits}, 0)
    `;
  } else {
    await sql`
      UPDATE credits SET
        balance = balance + ${pack.credits},
        total_allocated = total_allocated + ${pack.credits},
        updated_at = NOW()
      WHERE user_id = ${userId}::uuid
    `;
  }

  if (txId) {
    await sql`UPDATE transactions SET status = 'completed', flutterwave_ref = ${reference} WHERE id = ${txId}::uuid`;
  }

  return res.status(200).json({ ok: true, message: "Credits added" });
};
