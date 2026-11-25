import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { OrderCoordinator, calculateGstTotals, verifyWebhookSignature } from "../src/order_engine.mjs";

const SECRET = "test-webhook-secret";

function sign(payload, secret = SECRET) {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

test("calculates exact 15% GST-inclusive cent totals", () => {
  const res = calculateGstTotals([{ sku: "FLAT-WHITE", qty: 2, unitCentsTaxIncl: 575 }]);
  assert.deepEqual(res, { grossCents: 1150, netCents: 1000, gstCents: 150 });
});

test("reserves stock atomically, releases on TTL expiry, and rejects oversell", () => {
  const coord = new OrderCoordinator({ "BOWL-1": 2 }, 60_000);
  coord.reserveOrder("ord-1", [{ sku: "BOWL-1", qty: 2, unitCentsTaxIncl: 1800 }], 1_000);
  assert.equal(coord.available["BOWL-1"], 0);

  assert.throws(
    () => coord.reserveOrder("ord-2", [{ sku: "BOWL-1", qty: 1, unitCentsTaxIncl: 1800 }], 20_000),
    /Insufficient stock/,
  );

  // After TTL expires, stock returns and new reservation succeeds
  coord.reserveOrder("ord-2", [{ sku: "BOWL-1", qty: 1, unitCentsTaxIncl: 1800 }], 62_000);
  assert.equal(coord.orders.get("ord-1").status, "EXPIRED");
  assert.equal(coord.available["BOWL-1"], 1);
});

test("verifies HMAC webhook, deduplicates retries, and builds idempotent POS settlement batch", () => {
  const coord = new OrderCoordinator({ "PIZZA-9": 5 }, 60_000);
  coord.reserveOrder("ord-10", [{ sku: "PIZZA-9", qty: 2, unitCentsTaxIncl: 2300 }], 10_000);

  const rawPayload = JSON.stringify({ orderId: "ord-10", paid: true });
  assert.equal(verifyWebhookSignature(rawPayload, "deadbeef", SECRET), false);

  const sig = sign(rawPayload);
  const first = coord.handlePaymentWebhook({ eventId: "evt-1", orderId: "ord-10", rawPayload, signatureHex: sig, secret: SECRET, nowMs: 12_000 });
  const retry = coord.handlePaymentWebhook({ eventId: "evt-1", orderId: "ord-10", rawPayload, signatureHex: sig, secret: SECRET, nowMs: 13_000 });

  assert.equal(first.deduplicated, false);
  assert.equal(retry.deduplicated, true);
  assert.equal(coord.orders.get("ord-10").status, "PAID");

  const b1 = coord.buildPosSettlementBatch("akl-01");
  const b2 = coord.buildPosSettlementBatch("akl-01");
  assert.equal(b1.idempotencyKey, b2.idempotencyKey);
  assert.equal(b1.totalGrossCents, 4600);
});
