#!/usr/bin/env node
/**
 * Seed the "Rep Dashboard Translations" metaobject with the partial-payment
 * extension's UI strings (GRIT-5475, requirement #8).
 *
 * These English values become the BASE/default content of each entry. Per-language
 * translations are layered on top later via the Translate & Adapt app. Any locale
 * without a translation automatically falls back to the English base value below.
 *
 * SAFETY:
 *   - Dry-run by default. Prints a plan and writes nothing.
 *   - Pass --commit to actually create entries.
 *   - Idempotent: skips any entry whose translation_key already exists, so it is
 *     safe to re-run (e.g. after adding new strings).
 *
 * USAGE:
 *   SHOP=avon.myshopify.com SHOPIFY_ADMIN_TOKEN=shpat_xxx node scripts/seed-translations.mjs
 *   SHOP=avon.myshopify.com SHOPIFY_ADMIN_TOKEN=shpat_xxx node scripts/seed-translations.mjs --commit
 *
 * The token must be an Admin API access token with write_metaobjects scope
 * (the app's offline token works). Override the definition type / field keys via
 * MO_TYPE, MO_KEY_FIELD, MO_VALUE_FIELD if they differ from the defaults below.
 */

const SHOP = process.env.SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-10";
const TYPE = process.env.MO_TYPE || "rep_dashboard_translations";
// Field API keys are "key" / "value" (the admin labels them "Translation Key" /
// "Translation Value", but the underlying handles are key/value — confirmed in
// mco-avon-rep app/routes/api.translations.tsx).
const KEY_FIELD = process.env.MO_KEY_FIELD || "key";
const VALUE_FIELD = process.env.MO_VALUE_FIELD || "value";
const COMMIT = process.argv.includes("--commit");

if (!SHOP || !TOKEN) {
  console.error("Missing env. Set SHOP and SHOPIFY_ADMIN_TOKEN.");
  process.exit(1);
}

// --- The 57 partial-payment strings. [bracket] placeholders match the existing
// Rep Dashboard convention. handle is derived from key (underscores -> hyphens).
const ENTRIES = [
  // Balance summary
  ["partial_pay_outstanding_balance", "Outstanding balance"],
  ["partial_pay_total_outstanding", "Total outstanding"],
  ["partial_pay_overdue_warning", "[amount] overdue"],
  ["partial_pay_open_orders_one", "[count] open order"],
  ["partial_pay_open_orders_other", "[count] open orders"],
  ["partial_pay_pay_outstanding_balance", "Pay outstanding balance"],
  ["partial_pay_nothing_to_pay", "Nothing to pay"],
  ["partial_pay_no_outstanding_balance", "You have no outstanding balance"],
  // Payment form
  ["partial_pay_badge_overdue", "Overdue"],
  ["partial_pay_payment_method", "Payment method"],
  ["partial_pay_card_display", "Card: [brand] •••• [digits] ([name])"],
  ["partial_pay_card_select_option", "[brand] •••• [digits] ([name], exp [expiryMonth]/[expiryYear])"],
  ["partial_pay_no_payment_methods", "No payment methods available."],
  ["partial_pay_amount_to_pay", "Amount to pay"],
  ["partial_pay_max_payable", "Max payable: [amount]"],
  ["partial_pay_overdue_separated", "· [amount] overdue"],
  ["partial_pay_orders_label", "ORDERS"],
  ["partial_pay_allocated_full", "[allocated] allocated"],
  ["partial_pay_allocated_with_remaining", "[allocated] allocated · [remaining] remaining"],
  ["partial_pay_and_more_orders", "…and [count] more orders"],
  ["partial_pay_total", "Total"],
  ["partial_pay_pay_amount", "Pay [amount]"],
  ["partial_pay_processing", "Processing…"],
  ["partial_pay_processing_payment", "Processing your payment…"],
  ["partial_pay_not_now", "Not now"],
  // Results: success / partial / failed
  ["partial_pay_badge_paid", "Paid"],
  ["partial_pay_badge_partial", "Partial"],
  ["partial_pay_badge_failed", "Failed"],
  ["partial_pay_paid_successfully", "[amount] paid successfully"],
  ["partial_pay_partial_summary", "[paid] paid successfully. [failed] could not be processed."],
  ["partial_pay_overall_error", "Some payments could not be completed. See details below."],
  ["partial_pay_order_paid", "[amount] paid"],
  ["partial_pay_order_pending", "Pending"],
  ["partial_pay_paid_label", "Paid"],
  ["partial_pay_and_more", "…and [count] more"],
  ["partial_pay_retry", "Retry"],
  ["partial_pay_retry_failed", "Retry failed"],
  ["partial_pay_done", "Done"],
  // Errors & validation
  ["partial_pay_failed_to_load_balance", "Unable to load your balance. Please try again later."],
  ["partial_pay_payment_failed", "Payment failed. Please try again."],
  ["partial_pay_unexpected_error", "An unexpected error occurred. Please try again."],
  ["partial_pay_enter_valid_amount", "Please enter a valid amount."],
  ["partial_pay_select_payment_method", "Please select a payment method."],
  ["partial_pay_amount_exceeds_balance", "Amount cannot exceed outstanding balance of [amount]."],
  ["partial_pay_enter_valid_amount_gt_zero", "Please enter a valid amount greater than 0."],
  ["partial_pay_error_currency_mismatch", "The payment currency doesn't match the order currency. Please contact support."],
  ["partial_pay_error_card_declined", "Payment could not be completed. The card may have been declined."],
  ["partial_pay_error_no_matching_card", "The selected card is not available for this order."],
  ["partial_pay_error_generic", "Something went wrong with this payment. Please try again."],
  // Single-order "Pay Invoice" page (ActionExtension)
  ["partial_pay_make_a_payment", "Make a payment"],
  ["partial_pay_pay_invoice", "Pay Invoice"],
  ["partial_pay_payment_amount", "Payment amount"],
  ["partial_pay_no_payment_methods_action", "No payment methods found. Please add a card to your account."],
  ["partial_pay_payment_applied", "Payment of [amount] applied to order [orderName]."],
  ["partial_pay_payment_still_processing", "Payment submitted and is still processing."],
  ["partial_pay_remaining_balance", "Remaining balance: [amount]"],
  ["partial_pay_could_not_load_order", "Could not load order details."],
];

const handleFor = (key) => key.replace(/_/g, "-");

async function gql(query, variables) {
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    throw new Error("GraphQL errors: " + JSON.stringify(json.errors, null, 2));
  }
  return json.data;
}

async function verifyDefinition() {
  const data = await gql(
    `#graphql
    query ($type: String!) {
      metaobjectDefinitionByType(type: $type) {
        id
        type
        fieldDefinitions { key name }
      }
    }`,
    { type: TYPE },
  );
  const def = data.metaobjectDefinitionByType;
  if (!def) {
    throw new Error(
      `No metaobject definition of type "${TYPE}". Set MO_TYPE to the correct handle (see Manage definition).`,
    );
  }
  const fieldKeys = def.fieldDefinitions.map((f) => f.key);
  for (const f of [KEY_FIELD, VALUE_FIELD]) {
    if (!fieldKeys.includes(f)) {
      throw new Error(
        `Field "${f}" not found on definition. Fields are: ${fieldKeys.join(", ")}. ` +
          `Set MO_KEY_FIELD / MO_VALUE_FIELD accordingly.`,
      );
    }
  }
  console.log(`✓ Definition "${TYPE}" with fields [${fieldKeys.join(", ")}]`);
  return def;
}

async function fetchExistingKeys() {
  const existing = new Set();
  let cursor = null;
  do {
    const data = await gql(
      `#graphql
      query ($type: String!, $after: String) {
        metaobjects(type: $type, first: 250, after: $after) {
          nodes { field(key: "${KEY_FIELD}") { value } }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { type: TYPE, after: cursor },
    );
    for (const n of data.metaobjects.nodes) {
      if (n.field?.value) existing.add(n.field.value);
    }
    cursor = data.metaobjects.pageInfo.hasNextPage ? data.metaobjects.pageInfo.endCursor : null;
  } while (cursor);
  return existing;
}

async function createEntry(key, value) {
  const data = await gql(
    `#graphql
    mutation ($mo: MetaobjectCreateInput!) {
      metaobjectCreate(metaobject: $mo) {
        metaobject { handle }
        userErrors { field message code }
      }
    }`,
    {
      mo: {
        type: TYPE,
        handle: handleFor(key),
        fields: [
          { key: KEY_FIELD, value: key },
          { key: VALUE_FIELD, value },
        ],
      },
    },
  );
  const errs = data.metaobjectCreate.userErrors;
  if (errs.length) throw new Error(JSON.stringify(errs));
  return data.metaobjectCreate.metaobject.handle;
}

async function main() {
  console.log(`Shop: ${SHOP} | API ${API_VERSION} | ${COMMIT ? "COMMIT" : "DRY-RUN"}`);
  await verifyDefinition();
  const existing = await fetchExistingKeys();
  const toCreate = ENTRIES.filter(([k]) => !existing.has(k));
  const skipped = ENTRIES.length - toCreate.length;

  console.log(`\n${ENTRIES.length} strings | ${skipped} already exist | ${toCreate.length} to create\n`);
  for (const [k, v] of toCreate) console.log(`  + ${k}  ->  "${v}"`);

  if (!COMMIT) {
    console.log(`\nDry-run only. Re-run with --commit to create ${toCreate.length} entries.`);
    return;
  }

  console.log(`\nCreating ${toCreate.length} entries...`);
  let ok = 0;
  for (const [k, v] of toCreate) {
    try {
      const handle = await createEntry(k, v);
      ok++;
      console.log(`  ✓ ${handle}`);
    } catch (e) {
      console.error(`  ✗ ${k}: ${e.message}`);
    }
  }
  console.log(`\nDone. Created ${ok}/${toCreate.length}.`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
