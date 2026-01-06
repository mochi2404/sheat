import express from "express";
import { GoogleSpreadsheet } from "google-spreadsheet";

const app = express();
app.use(express.json({ limit: "2mb" }));

/**
 * ENV vars you must set on Render:
 * - SHEET_ID: Google Sheet ID (the long string in the URL)
 * - GOOGLE_SERVICE_ACCOUNT_EMAIL
 * - GOOGLE_PRIVATE_KEY  (keep \n formatting!)
 */
const SHEET_ID = process.env.SHEET_ID;
const SA_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
let SA_KEY = process.env.GOOGLE_PRIVATE_KEY;

// Render usually stores \n as literal "\\n"
if (SA_KEY) SA_KEY = SA_KEY.replace(/\\n/g, "\n");

function isoDateOnly(iso) {
  if (!iso || typeof iso !== "string") return "";
  return iso.slice(0, 10); // YYYY-MM-DD
}

function pickProduct(body) {
  // prefer first orderline product_name
  const fromOrderlines = body?.orderlines?.[0]?.product_name;
  if (fromOrderlines) return fromOrderlines;

  // fallback from final_variants keys
  const fv = body?.final_variants || {};
  const keys = Object.keys(fv);
  return keys.length ? keys[0] : "";
}

function detectEvent(body) {
  // Best-effort: determine which payload type this is
  const hasGross = body?.gross_revenue !== undefined;
  const hasPaidTime = body?.paid_time !== null && body?.paid_time !== undefined;
  const hasPaymentStatus = body?.payment_status !== undefined;

  const looksLikePayment = body?.id !== undefined && hasPaidTime && hasPaymentStatus;
  const looksLikeDeleted =
    body?.order_id && body?.created_at && body?.last_updated_at && Object.keys(body).length <= 4;

  if (looksLikePayment) return "order.payment_status_changed";
  if (looksLikeDeleted) return "order.deleted";
  if (hasGross) return "order.payload"; // created / updated / epayment_created often have gross_revenue
  if (body?.status !== undefined && body?.draft_time !== undefined) return "order.status_changed";
  return "unknown";
}

async function getDoc() {
  if (!SHEET_ID || !SA_EMAIL || !SA_KEY) {
    throw new Error("Missing env vars: SHEET_ID / GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY");
  }
  const doc = new GoogleSpreadsheet(SHEET_ID);
  await doc.useServiceAccountAuth({ client_email: SA_EMAIL, private_key: SA_KEY });
  await doc.loadInfo();
  return doc;
}

async function appendRow(sheetTitle, rowObj) {
  const doc = await getDoc();
  const sheet = doc.sheetsByTitle[sheetTitle];
  if (!sheet) throw new Error(`Sheet not found: ${sheetTitle}`);
  await sheet.addRow(rowObj, { insert: true });
}

// healthcheck (Scalev validator often checks GET)
app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// main webhook endpoint
app.post("/webhook/scalev", async (req, res) => {
  try {
    const body = req.body || {};
    const eventType = detectEvent(body);

    const order_id = body.order_id || "";
    const created_at = body.created_at || "";
    const paid_time = body.paid_time || "";
    const payment_status = (body.payment_status || "").toLowerCase();
    const status = (body.status || "").toLowerCase();
    const last_updated_at = body.last_updated_at || "";

    const is_spam = body.is_probably_spam === true || !!body.mark_as_spam_by;
    const is_canceled = status === "canceled";
    const is_deleted = eventType === "order.deleted";

    // Always respond 200 quickly so Scalev doesn't retry
    res.status(200).json({ ok: true });

    // Async write (still in same request lifecycle, but after response)
    // ORDERS_MASTER: for order payloads (created/updated/epayment_created/status_changed)
    if (eventType !== "order.payment_status_changed") {
      // If it is deleted payload, we still record it in orders master as deleted
      const product = pickProduct(body);
      const gross_revenue = body.gross_revenue ?? ""; // include ongkir as requested
      await appendRow("ORDERS_MASTER", {
        order_id,
        created_at,
        created_date: isoDateOnly(created_at),
        product,
        gross_revenue,
        status,
        is_spam,
        is_canceled,
        is_deleted,
        last_updated_at
      });
    }

    // PAYMENTS_STATUS: only payment status changes
    if (eventType === "order.payment_status_changed") {
      await appendRow("PAYMENTS_STATUS", {
        order_id,
        paid_time,
        paid_date: isoDateOnly(paid_time),
        payment_status,
        last_updated_at
      });
    }
  } catch (err) {
    // We already returned 200 in normal path; for exceptions before that:
    console.error(err);
    try {
      res.status(200).json({ ok: true }); // keep Scalev from retry storm
    } catch (_) {}
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("listening on", port));
