// Cash on Delivery (COD) orders are collected on delivery, so they must be
// excluded from partial payments (GRIT-5699) to avoid double-charging the
// customer (pay on Shopify AND pay on delivery).
//
// COD orders in Avon's store carry no payment terms (paymentTerms is null);
// they are identified by their payment gateway, e.g. "Cash on Delivery (COD)".
const COD_GATEWAY_PATTERN = /cash on delivery|\bcod\b/i;

/**
 * Returns true if an order is a Cash on Delivery order.
 * Expects the order's `paymentGatewayNames` to have been queried.
 *
 * @param {{ paymentGatewayNames?: string[] }} order
 * @returns {boolean}
 */
export function isCodOrder(order) {
  const gateways = order?.paymentGatewayNames || [];
  return gateways.some((g) => COD_GATEWAY_PATTERN.test(g || ""));
}
