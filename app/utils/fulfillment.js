// Unfulfilled orders (nothing shipped yet) are excluded from partial payments:
// a rep shouldn't be charged for goods they haven't received. Follow-up to the
// COD exclusion — see ./cod.js (GRIT-5699).
//
// "Unfulfilled" means fully unfulfilled only; partially-fulfilled orders remain
// payable. Expects the order's `displayFulfillmentStatus` to have been queried.

/**
 * Returns true if an order has had nothing fulfilled yet.
 *
 * @param {{ displayFulfillmentStatus?: string }} order
 * @returns {boolean}
 */
export function isUnfulfilledOrder(order) {
  return order?.displayFulfillmentStatus === "UNFULFILLED";
}
