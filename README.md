# Omnichannel Order & POS Settlement Sync

Zero-dependency Node.js (ESM) online ordering state machine, atomic inventory reservation, timing-safe HMAC payment webhook verifier, and idempotent POS settlement batcher.

## Problem

Web storefronts and multi-channel online ordering systems regularly break under real traffic due to:

1. **Overselling hot SKUs** when concurrent checkout carts omit short-TTL inventory holds before payment callback arrives.
2. **Duplicate or forged webhook deliveries** when payment gateways retry callbacks or omit valid HMAC-SHA256 signatures.
3. **Settlement reconciliation drift** from cent-rounding mismatches on GST-inclusive line items and non-idempotent POS exports.

## Running Tests

```bash
node --test
```
