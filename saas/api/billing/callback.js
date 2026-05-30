const { sql, initDB } = require("../_db");

const DODO_API = "https://live.dodopayments.com";

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

  const { tx, pack, credits, cancelled } = req.query;

  // Handle cancellation
  if (cancelled === "true") {
    return res.send(`<!DOCTYPE html><html><head><title>Payment Cancelled</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0a;color:#fff;text-align:center}.card{padding:3rem;border-radius:16px;background:#1a1a1a;max-width:400px}h2{margin:0 0 1rem;font-size:1.5rem}p{color:#888;margin:0 0 2rem}</style>
</head><body><div class="card"><h2>Payment Cancelled</h2><p>No charges were made. You can close this window.</p>
<script>setTimeout(()=>window.close(),2000);</script></div></body></html>`);
  }

  if (!tx || !pack) {
    return res.status(400).send("Missing parameters");
  }

  const packData = PACKS[pack];
  const creditAmount = credits ? parseInt(credits, 10) : (packData ? packData.credits : 0);

  // Check if transaction was already completed (webhook may have fired first)
  const txRow = await sql`SELECT status FROM transactions WHERE id = ${tx}::uuid`;
  const isCompleted = txRow.length && txRow[0].status === "completed";

  // If not yet completed by webhook, try to verify and complete now
  if (!isCompleted) {
    const dodoKey = process.env.DODO_PAYMENTS_API_KEY;
    if (dodoKey) {
      try {
        // Check recent payments for this user
        // Since we don't have the payment_id from the redirect, we rely on the webhook
        // But we can poll the transaction status
        const recentTx = await sql`
          SELECT status FROM transactions 
          WHERE id = ${tx}::uuid 
          AND created_at > NOW() - INTERVAL '30 minutes'
        `;
        if (recentTx.length && recentTx[0].status !== "completed") {
          // Mark as processing — webhook will complete it
          await sql`UPDATE transactions SET status = 'processing' WHERE id = ${tx}::uuid AND status = 'pending'`;
        }
      } catch (e) {
        console.log("Callback verification error:", e.message);
      }
    }
  }

  // Show success page
  return res.send(`<!DOCTYPE html><html><head><title>Payment Processing</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0a;color:#fff;text-align:center}
.card{padding:3rem;border-radius:16px;background:#1a1a1a;max-width:420px}
h2{margin:0 0 0.5rem;font-size:1.5rem;color:#4ade80}
.credits{font-size:2.5rem;font-weight:700;margin:1rem 0;background:linear-gradient(135deg,#4ade80,#22d3ee);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
p{color:#888;margin:0.5rem 0;line-height:1.5}
.note{font-size:0.85rem;color:#666;margin-top:1.5rem}
.spinner{width:24px;height:24px;border:3px solid #333;border-top-color:#4ade80;border-radius:50%;animation:spin 0.8s linear infinite;margin:1rem auto}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head><body><div class="card">
<h2>✓ Payment ${isCompleted ? "Successful!" : "Processing..."}</h2>
<div class="credits">${creditAmount.toLocaleString()} credits</div>
<p>${isCompleted ? "Added to your account." : "Being processed — credits will appear shortly."}</p>
${!isCompleted ? '<div class="spinner"></div>' : ''}
<p class="note">You can close this window and return to TaskBolt.</p>
<script>
// Notify parent window if opened as popup
if(window.opener){window.opener.postMessage({type:'payment_complete',credits:${creditAmount},completed:${isCompleted}},'*');}
setTimeout(()=>window.close(),${isCompleted ? 2000 : 5000});
</script>
</div></body></html>`);
};
