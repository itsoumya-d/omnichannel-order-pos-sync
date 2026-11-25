import { createHmac, createHash, timingSafeEqual } from "node:crypto";

/**
 * Computes integer-cent line totals and extracted 15% NZ GST component.
 */
export function calculateGstTotals(items, gstRate = 0.15) {
  let grossCents = 0;
  for (const item of items) {
    if (!Number.isInteger(item.qty) || item.qty <= 0) {
      throw new RangeError(`Invalid qty for SKU ${item.sku}`);
    }
    if (!Number.isInteger(item.unitCentsTaxIncl) || item.unitCentsTaxIncl < 0) {
      throw new RangeError(`Invalid unit price for SKU ${item.sku}`);
    }
    grossCents += item.qty * item.unitCentsTaxIncl;
  }
  const gstCents = Math.round((grossCents * gstRate) / (1 + gstRate));
  return { grossCents, netCents: grossCents - gstCents, gstCents };
}

/**
 * Verifies raw webhook body against HMAC-SHA256 hex digest using constant-time comparison.
 */
export function verifyWebhookSignature(rawBody, signatureHex, secret) {
  if (typeof signatureHex !== "string" || !/^[a-f0-9]{64}$/i.test(signatureHex)) {
    return false;
  }
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signatureHex, "hex"));
}

/**
 * In-memory omnichannel stock reservation, payment webhook transition, and idempotent POS settlement.
 */
export class OrderCoordinator {
  constructor(initialStock = {}, reservationTtlMs = 300_000) {
    this.available = { ...initialStock };
    this.reservationTtlMs = reservationTtlMs;
    this.orders = new Map();
    this.seenWebhooks = new Set();
  }

  purgeExpiredReservations(nowMs) {
    let released = 0;
    for (const order of this.orders.values()) {
      if (order.status === "RESERVED" && nowMs >= order.expiresAtMs) {
        for (const item of order.items) {
          this.available[item.sku] = (this.available[item.sku] ?? 0) + item.qty;
        }
        order.status = "EXPIRED";
        released += 1;
      }
    }
    return released;
  }

  reserveOrder(orderId, items, nowMs = Date.now()) {
    this.purgeExpiredReservations(nowMs);
    if (this.orders.has(orderId)) {
      return this.orders.get(orderId);
    }
    const totals = calculateGstTotals(items);
    for (const item of items) {
      const stock = this.available[item.sku] ?? 0;
      if (stock < item.qty) {
        throw new Error(`Insufficient stock for SKU ${item.sku}: requested ${item.qty}, available ${stock}`);
      }
    }
    for (const item of items) {
      this.available[item.sku] -= item.qty;
    }
    const order = {
      orderId,
      items: items.map((i) => ({ ...i })),
      totals,
      status: "RESERVED",
      expiresAtMs: nowMs + this.reservationTtlMs,
      paidAtMs: null,
    };
    this.orders.set(orderId, order);
    return order;
  }

  handlePaymentWebhook({ eventId, orderId, rawPayload, signatureHex, secret, nowMs = Date.now() }) {
    if (!verifyWebhookSignature(rawPayload, signatureHex, secret)) {
      throw new Error("Invalid payment webhook HMAC signature");
    }
    if (this.seenWebhooks.has(eventId)) {
      return { deduplicated: true, order: this.orders.get(orderId) ?? null };
    }
    this.seenWebhooks.add(eventId);
    this.purgeExpiredReservations(nowMs);

    const order = this.orders.get(orderId);
    if (!order) {
      throw new Error(`Unknown order ${orderId}`);
    }
    if (order.status !== "RESERVED") {
      throw new Error(`Order ${orderId} cannot be settled from state ${order.status}`);
    }
    order.status = "PAID";
    order.paidAtMs = nowMs;
    return { deduplicated: false, order };
  }

  buildPosSettlementBatch(storeId) {
    const paidOrders = [...this.orders.values()]
      .filter((o) => o.status === "PAID")
      .sort((a, b) => a.orderId.localeCompare(b.orderId))
      .map((o) => ({
        orderId: o.orderId,
        grossCents: o.totals.grossCents,
        gstCents: o.totals.gstCents,
      }));
    const canonical = JSON.stringify({ storeId, paidOrders });
    const batchKey = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
    return {
      storeId,
      idempotencyKey: `${storeId}:${batchKey}`,
      orderCount: paidOrders.length,
      totalGrossCents: paidOrders.reduce((acc, o) => acc + o.grossCents, 0),
      orders: paidOrders,
    };
  }
}
