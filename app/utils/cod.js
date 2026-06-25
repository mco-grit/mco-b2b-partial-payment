// Cash on Delivery (COD) orders are configured in Avon's store with a
// "due on receipt" payment term. Payment for these is collected on delivery,
// so they must be excluded from partial payments (GRIT-5699) to avoid
// double-charging the customer (pay on Shopify AND pay on delivery).
const COD_PAYMENT_TERMS_TYPE = "RECEIPT";

/**
 * Returns true if an order is a Cash on Delivery order.
 * Expects the order's `paymentTerms { paymentTermsType }` to have been queried.
 *
 * @param {{ paymentTerms?: { paymentTermsType?: string } }} order
 * @returns {boolean}
 */
export function isCodOrder(order) {
  return order?.paymentTerms?.paymentTermsType === COD_PAYMENT_TERMS_TYPE;
}
