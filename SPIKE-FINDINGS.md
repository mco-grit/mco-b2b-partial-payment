# B2B Partial Payment Spike — Findings

**Date:** 2026-03-20
**Store tested:** avon-prod.myshopify.com
**Order tested:** #1156 (£31.00 GBP, Net 30 terms)

---

## What worked as expected

### 1. Customer Account UI Extension renders on order detail page
- Extension target `customer-account.order-status.block.render` works
- Shows outstanding balance, payment amount input, and Pay button
- Must be added to the "Order status" page in the Customer Account editor (Settings → Customer accounts → Customize)
- Uses Preact with `<s-*>` web components (2026 extension model)

### 2. Extension passes order ID and amount to app backend
- `useOrder()` hook provides the order GID
- `useSessionToken()` provides customer authentication
- `fetch()` to the app backend works with CORS headers
- Session token validates the customer identity

### 3. `orderCreateMandatePayment` works with partial amounts
- Successfully charged £10 against a £31 order
- Order status updated from `PENDING` to `PARTIALLY_PAID`
- Outstanding balance correctly updated from £31 to £21
- No staff session required — works with the app's offline access token
- `autoCapture: true` captures the payment immediately

### 4. Job polling works
- Mutation returns a Job ID
- Polling `job(id:)` with `done` field works
- Note: `errors` field does NOT exist on `Job` type
- Job typically resolves within 2-4 seconds

### 5. Transactional emails
- Shopify automatically sends "Order payment receipt email" to the customer for each mandate payment
- Emails are sent immediately upon payment processing
- These use the standard Shopify notification template (configurable in Settings → Notifications)
- Refund notification emails are also sent automatically

### 6. Refund behavior
- Refund method defaults to "Original payment" — automatically routes back to the Visa used for mandate payment
- Each partial payment is listed as a separate refundable transaction
- Merchant can selectively refund individual partial payments
- No manual merchant action required — Shopify handles it automatically
- **Important:** Refunds do NOT increase the order's outstanding balance. If £20 was paid and £5 is refunded, the balance stays at £11 (calculated from gross payments £31 - £20), not £16 (£31 - £15 net). This is Shopify's built-in behavior and cannot be changed. Merchants should be aware of this when issuing refunds on partially paid orders.

---

## What didn't work / required workarounds

### 1. Protected API scopes required
- `read_payment_mandate` and `write_payment_mandate` are protected scopes
- Must be requested through Partner Dashboard → API access requests
- In our case, approval was instant after submitting justification
- Without these scopes, `paymentCollectionDetails.vaultedPaymentMethods` returns access denied

### 2. Extension target mismatch
- Initial target `customer-account.order.action.menu-item.render` (action menu) never rendered visibly
- Switched to `customer-account.order-status.block.render` (block) which works
- The action menu targets may work but require specific configuration
- **Recommendation:** Use block render targets for reliability

### 3. GraphQL API field differences from documentation
- `orderCreateMandatePayment` argument is `id` (not `orderId`)
- `Job` type does not have an `errors` field
- `PaymentMandate` type does not have a `name` field
- Idempotency key must be ≤ 32 characters (UUID with dashes is 36)
- API version `2025-01` is deprecated; use `2025-10` or later

### 4. Session storage on Render
- SQLite is ephemeral on Render (wiped on each deploy)
- Must use PostgreSQL for persistent session storage
- OAuth session must be re-established by opening the app in admin after first deploy

### 5. Vaulted card requirement
- `orderCreateMandatePayment` requires a vaulted payment method on the order
- Customer must have previously saved a credit card (through checkout or customer account)
- Requires Shopify Payments — does not work with Bogus Gateway or third-party processors
- If no vaulted card exists, the payment flow cannot proceed

### 6. Order list page shows original total
- Shopify's built-in order list card always shows the original order total (e.g. £31.00)
- It does NOT reflect partial payments or updated outstanding balance
- The order detail page correctly shows the outstanding balance
- **Recommendation for MVP:** Add an `order-index.block.render` extension showing orders with pending balances

### 7. Double payment risk
- If the button is clicked multiple times, duplicate payments can be processed
- Fixed with `useRef` submission guard and button disabled state
- **Recommendation for MVP:** Server-side idempotency using orderId + amount hash

### 8. `useExtension().appUrl` is undefined
- The `appUrl` property is not available on the extension API in `order-status.block.render` context
- Had to hardcode the Render URL in the extension
- **Recommendation for MVP:** Use environment variable or extension settings for the app URL

---

## Transactional email summary

| Event | Email sent? | Template |
|-------|------------|----------|
| Mandate payment collected | Yes — automatic | "Order payment receipt" |
| Refund issued | Yes — automatic | "Refund notification" |
| Order confirmation | Yes — automatic (at order creation) | "Order confirmation" |

All emails are configurable in Settings → Notifications.

---

## Test 2: API-Created Orders (ISL Late Payment Fee Simulation)

**Goal:** Validate that `orderCreateMandatePayment` works on orders created purely via API — no checkout, no invoice flow. This simulates how ISL would create late payment fee orders.

**Reference:** [Shopify community thread on mandate payments for payment-pending orders](https://community.shopify.dev/t/testing-paymentmandates-to-pay-for-created-payment-pending-orders/31955)

### Steps performed

1. **Created a draft order** via `draftOrderCreate` with `purchasingEntity` assigning it to Lak LLC's CompanyLocation. No payment terms set (API has a gap — requires `issueDate` but the field doesn't exist on the input type).

2. **Completed the draft** with `draftOrderComplete(paymentPending: true)` — created Order #1171, status `PENDING`, £5.00 outstanding.

3. **Queried `paymentCollectionDetails.vaultedPaymentMethods`** on the new order — **the vaulted card was returned** (same mandate ID as checkout-created orders).

4. **Called `orderCreateMandatePayment`** with a partial amount of £3.00 — **succeeded**, Job returned with no errors.

### Key findings

- **API-created orders work with mandate payments** — no checkout or invoice flow needed
- **Vaulted card is resolved from the CompanyLocation level**, not the order level. As long as the order is assigned to a CompanyLocation that has a customer with a vaulted card, the mandate is available regardless of how the order was created.
- **The community thread concern is not a problem for B2B.** The thread warns that draft-order-originated orders won't have vaulted payment methods because vault attachment happens during checkout. This is true for D2C orders, but **B2B mandates are resolved from the CompanyLocation**, not from checkout history.
- **Payment terms gap:** `draftOrderCreate` requires an `issueDate` for net payment terms but the input type doesn't accept it. Workaround: create without payment terms and use `paymentPending: true` on `draftOrderComplete`.

### Working GraphQL mutations for API-created order flow

```graphql
# Step 1: Find Company, Location, Contact IDs
{
  companies(first: 5, query: "Company Name") {
    edges {
      node {
        id
        name
        locations(first: 5) {
          edges { node { id name } }
        }
      }
    }
  }
}

{
  companyLocation(id: "gid://shopify/CompanyLocation/XXX") {
    roleAssignments(first: 10) {
      edges {
        node {
          companyContact {
            id
            customer { email }
          }
        }
      }
    }
  }
}

# Step 2: Create draft order
mutation {
  draftOrderCreate(input: {
    lineItems: [{ title: "Late Payment Fee", originalUnitPrice: "5.00", quantity: 1 }]
    purchasingEntity: {
      purchasingCompany: {
        companyId: "gid://shopify/Company/XXX"
        companyLocationId: "gid://shopify/CompanyLocation/XXX"
        companyContactId: "gid://shopify/CompanyContact/XXX"
      }
    }
  }) {
    draftOrder { id name }
    userErrors { field message }
  }
}

# Step 3: Complete with payment pending
mutation {
  draftOrderComplete(id: "gid://shopify/DraftOrder/XXX", paymentPending: true) {
    draftOrder {
      order {
        id name displayFinancialStatus
        totalOutstandingSet { shopMoney { amount currencyCode } }
      }
    }
    userErrors { field message }
  }
}

# Step 4: Query vaulted payment methods
{
  order(id: "gid://shopify/Order/XXX") {
    paymentCollectionDetails { vaultedPaymentMethods { id } }
  }
}

# Step 5: Create mandate payment
mutation {
  orderCreateMandatePayment(
    id: "gid://shopify/Order/XXX"
    mandateId: "gid://shopify/PaymentMandate/XXX"
    idempotencyKey: "unique-key-max-32-chars"
    amount: { amount: "3.00", currencyCode: GBP }
    autoCapture: true
  ) {
    job { id done }
    userErrors { field message }
  }
}

# Step 6: Verify
{
  order(id: "gid://shopify/Order/XXX") {
    id name displayFinancialStatus
    totalOutstandingSet { shopMoney { amount currencyCode } }
  }
}
```

---

## Architecture notes for MVP

### Required scopes
`read_orders`, `write_orders`, `read_payment_mandate`, `write_payment_mandate`

### Extension structure
- Single extension with target `customer-account.order-status.block.render`
- Consider adding `customer-account.order-index.block.render` for order list visibility

### Backend requirements
- PostgreSQL for session persistence (not SQLite)
- Shopify Payments must be the payment processor
- App must be installed and OAuth'd on the store

### Key mutations/queries
```graphql
# Get order details
query {
  order(id: $id) {
    totalOutstandingSet { shopMoney { amount currencyCode } }
  }
}

# Get vaulted payment methods (requires read_payment_mandate)
query {
  order(id: $id) {
    paymentCollectionDetails { vaultedPaymentMethods { id } }
  }
}

# Create mandate payment (requires write_payment_mandate)
mutation {
  orderCreateMandatePayment(
    id: $id
    mandateId: $mandateId
    idempotencyKey: $key
    amount: $amount
    autoCapture: true
  ) {
    job { id done }
    userErrors { field message }
  }
}
```

---

## Assessment

**The skeleton is suitable to build the MVP on top of.** The core flow works end-to-end: extension renders on order detail page, customer authenticates via session token, backend charges vaulted card via `orderCreateMandatePayment`, order status updates to `PARTIALLY_PAID`, customer sees success state, and Shopify sends payment receipt email automatically.

### Key gaps for MVP
1. Order list page needs a custom extension to show outstanding balances
2. Server-side idempotency to prevent duplicate payments
3. App URL should not be hardcoded in the extension
4. UI polish and Avon branding
5. Error handling beyond basic success/failure
6. Refund behavior documentation for merchant training (refunds don't increase outstanding balance)
