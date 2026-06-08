import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useState, useEffect, useCallback, useRef, useMemo } from "preact/hooks";
import { useSessionToken } from "@shopify/ui-extensions/customer-account/preact";
import { useTranslations } from "./translations.js";

const APP_URL = "https://mco-b2b-partial-payment.onrender.com";

export default async () => {
  render(<BalanceBlock />, document.body);
};

function friendlyError(raw, t) {
  if (!raw) return t("partial_pay_error_generic");
  const lower = raw.toLowerCase();
  if (lower.includes("currency") && lower.includes("match")) return t("partial_pay_error_currency_mismatch");
  if (lower.includes("declined") || lower.includes("balance did not decrease")) return t("partial_pay_error_card_declined");
  if (lower.includes("no matching payment method")) return t("partial_pay_error_no_matching_card");
  if (lower.includes("job not found") || lower.includes("no job")) return t("partial_pay_error_generic");
  // If it looks like a raw API message (long, technical), replace it
  if (raw.length > 80 || /[A-Z]{2,}/.test(raw)) return t("partial_pay_error_generic");
  return raw;
}

// Mirror of server-side allocation in api.batch-pay.js
function allocate(orders, requestedAmount) {
  const total = orders.reduce((s, o) => s + parseFloat(o.outstanding), 0);
  let remaining = Math.min(requestedAmount, total);
  const allocations = [];
  for (const o of orders) {
    if (remaining <= 0.0001) break;
    const out = parseFloat(o.outstanding);
    const applied = Math.min(out, remaining);
    if (applied > 0) {
      allocations.push({
        orderId: o.id,
        name: o.name,
        applied: applied.toFixed(2),
        remainingOnOrder: (out - applied).toFixed(2),
      });
      remaining -= applied;
    }
  }
  return allocations;
}

function BalanceBlock() {
  const sessionToken = useSessionToken();
  const t = useTranslations(APP_URL, () => sessionToken.get());

  const [loading, setLoading] = useState(true);
  const [info, setInfo] = useState(null);
  const [error, setError] = useState("");

  const [expanded, setExpanded] = useState(false);
  const [amount, setAmount] = useState("");
  const [paymentMethodId, setPaymentMethodId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState(null);
  const attemptRef = useRef(1);
  const sessionIdRef = useRef(Math.random().toString(36).slice(2, 10));

  const fetchInfo = useCallback(async () => {
    try {
      const token = await sessionToken.get();
      const response = await fetch(`${APP_URL}/api/batch-pay`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ op: "get-info" }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error || t("partial_pay_failed_to_load_balance"));
        return;
      }
      setInfo(data);
      const validMethod = (data.paymentMethods || []).find((m) => !m.expired);
      if (validMethod) setPaymentMethodId(validMethod.fingerprint || validMethod.id);
      // Pre-fill with overdue balance if > 0, otherwise total outstanding
      const overdue = parseFloat(data.overdueOutstanding);
      if (overdue > 0) {
        setAmount(data.overdueOutstanding);
      } else if (parseFloat(data.totalOutstanding) > 0) {
        setAmount(data.totalOutstanding);
      } else {
        setAmount("");
      }
    } catch (e) {
      setError(t("partial_pay_failed_to_load_balance"));
    } finally {
      setLoading(false);
    }
  }, [sessionToken, t]);

  useEffect(() => {
    fetchInfo();
  }, [fetchInfo]);

  useEffect(() => {
    if (loading || !info || parseFloat(info.totalOutstanding) <= 0) return;
    try {
      const search =
        shopify?.navigation?.currentEntry?.url
          ? new URL(shopify.navigation.currentEntry.url).search
          : window.location.search;
      const params = new URLSearchParams(search);
      if (params.get("openPay") === "1") setExpanded(true);
    } catch (e) {
      // ignore — auto-expand is best-effort
    }
  }, [loading, info]);

  const allocations = useMemo(() => {
    if (!info || !amount) return [];
    const parsed = parseFloat(amount);
    if (isNaN(parsed) || parsed <= 0) return [];
    return allocate(info.orders, parsed);
  }, [info, amount]);

  const formatMoney = useMemo(() => {
    const currency = info?.currencyCode;
    if (!currency) return (v) => String(v);
    const formatter = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    });
    return (v) => {
      const n = parseFloat(v);
      return isNaN(n) ? String(v) : formatter.format(n);
    };
  }, [info?.currencyCode]);

  // Step 2 of the ticket uses currency codes (e.g. "66.80 GBP") rather than symbols
  const formatCode = useMemo(() => {
    const currency = info?.currencyCode || "";
    return (v) => {
      const n = parseFloat(v);
      if (isNaN(n)) return String(v);
      return currency ? `${n.toFixed(2)} ${currency}` : n.toFixed(2);
    };
  }, [info?.currencyCode]);

  const handleSubmit = useCallback(async () => {
    if (submitting) return;
    const parsed = parseFloat(amount);
    if (isNaN(parsed) || parsed <= 0) {
      setError(t("partial_pay_enter_valid_amount"));
      return;
    }
    if (!paymentMethodId) {
      setError(t("partial_pay_select_payment_method"));
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const token = await sessionToken.get();
      const response = await fetch(`${APP_URL}/api/batch-pay`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          op: "pay",
          paymentMethodId,
          amount: parsed.toFixed(2),
          attempt: attemptRef.current,
          sessionId: sessionIdRef.current,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(friendlyError(data.error, t));
        setSubmitting(false);
        return;
      }
      setResults(data.results || []);
      setSubmitting(false);
    } catch (e) {
      setError(t("partial_pay_payment_failed"));
      setSubmitting(false);
    }
  }, [amount, paymentMethodId, sessionToken, submitting, t]);

  const handleRetry = useCallback(async () => {
    attemptRef.current += 1;
    setResults(null);
    await fetchInfo();
  }, [fetchInfo]);

  const handleCollapse = useCallback(async () => {
    setExpanded(false);
    setResults(null);
    setError("");
    attemptRef.current = 1;
    sessionIdRef.current = Math.random().toString(36).slice(2, 10);
    // Shopify needs time to settle order financial state after job completes
    setLoading(true);
    await new Promise((r) => setTimeout(r, 5000));
    await fetchInfo();
  }, [fetchInfo]);

  const handleCancel = useCallback(() => {
    setExpanded(false);
    setError("");
  }, []);

  if (loading) return null;

  if (error && !info) {
    return (
      <s-section>
        <s-banner tone="critical">
          <s-text>{error}</s-text>
        </s-banner>
      </s-section>
    );
  }

  if (!info || parseFloat(info.totalOutstanding) <= 0) {
    return (
      <s-section>
        <s-heading>{t("partial_pay_outstanding_balance")}</s-heading>
        <s-stack direction="block" gap="base" alignItems="center">
          <s-icon type="check-circle" tone="neutral" size="large"></s-icon>
          <s-text type="strong">{t("partial_pay_nothing_to_pay")}</s-text>
          <s-text color="subdued">{t("partial_pay_no_outstanding_balance")}</s-text>
        </s-stack>
      </s-section>
    );
  }

  // Collapsed widget
  if (!expanded) {
    return (
      <s-section>
        <s-heading>{t("partial_pay_outstanding_balance")}</s-heading>
        <s-stack direction="block" gap="base">
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-stack direction="block" gap="small">
              <s-text type="small" color="subdued">
                {t("partial_pay_total_outstanding")}
              </s-text>
              <s-heading>{formatMoney(info.totalOutstanding)}</s-heading>
            </s-stack>
          </s-box>
          {parseFloat(info.overdueOutstanding) > 0 && (
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-icon type="alert-triangle" tone="critical"></s-icon>
              <s-text tone="critical">
                {t("partial_pay_overdue_warning", { amount: formatMoney(info.overdueOutstanding) })}
              </s-text>
            </s-stack>
          )}
          <s-text color="subdued">
            {info.orders.length === 1
              ? t("partial_pay_open_orders_one", { count: info.orders.length })
              : t("partial_pay_open_orders_other", { count: info.orders.length })}
          </s-text>
          <s-button variant="primary" onClick={() => setExpanded(true)}>
            {t("partial_pay_pay_outstanding_balance")}
          </s-button>
        </s-stack>
      </s-section>
    );
  }

  // Expanded — results screen
  if (results) {
    const succeeded = results.filter((r) => r.status === "success");
    const failed = results.filter((r) => r.status === "failed");
    const pending = results.filter((r) => r.status === "pending");
    const successTotal = succeeded.reduce((s, r) => s + parseFloat(r.applied), 0).toFixed(2);
    const failedTotal = failed.reduce((s, r) => s + parseFloat(r.applied || 0), 0).toFixed(2);
    const allFailed = succeeded.length === 0 && failed.length > 0;
    const allSuccess = failed.length === 0 && pending.length === 0;
    const badgeLabel = allSuccess
      ? t("partial_pay_badge_paid")
      : allFailed
        ? t("partial_pay_badge_failed")
        : t("partial_pay_badge_partial");

    return (
      <s-section>
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-heading>{t("partial_pay_pay_outstanding_balance")}</s-heading>
            <s-badge tone={allFailed ? "critical" : "neutral"} color="subdued">
              {badgeLabel}
            </s-badge>
          </s-stack>
          <s-divider></s-divider>

          {allSuccess ? (
            <s-banner tone="success">
              <s-text>{t("partial_pay_paid_successfully", { amount: formatCode(successTotal) })}</s-text>
            </s-banner>
          ) : allFailed ? (
            <s-banner tone="critical">
              <s-text>{t("partial_pay_overall_error")}</s-text>
            </s-banner>
          ) : (
            <s-banner tone="warning">
              <s-text>
                {t("partial_pay_partial_summary", {
                  paid: formatCode(successTotal),
                  failed: formatCode(failedTotal),
                })}
              </s-text>
            </s-banner>
          )}

          <s-text type="small" color="subdued">{t("partial_pay_orders_label")}</s-text>
          {results.slice(0, 10).map((r) => (
            <s-box key={r.orderId} padding="base" background="subdued" borderRadius="base">
              <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
                <s-stack direction="block" gap="small-100">
                  <s-text type="strong">{r.name}</s-text>
                  {r.status === "success" && (
                    <s-stack direction="inline" gap="small-100" alignItems="center">
                      <s-icon type="check-circle" tone="success" size="small"></s-icon>
                      <s-text tone="success">
                        {t("partial_pay_order_paid", { amount: formatCode(r.applied) })}
                      </s-text>
                    </s-stack>
                  )}
                  {r.status === "failed" && (
                    <s-text tone="critical">{friendlyError(r.error, t)}</s-text>
                  )}
                  {r.status === "pending" && (
                    <s-text color="subdued">{t("partial_pay_order_pending")}</s-text>
                  )}
                </s-stack>
                <s-text type="strong">{formatCode(r.applied)}</s-text>
              </s-grid>
            </s-box>
          ))}
          {results.length > 10 && (
            <s-text color="subdued">{t("partial_pay_and_more", { count: results.length - 10 })}</s-text>
          )}

          <s-divider></s-divider>
          {allSuccess && (
            <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
              <s-text color="subdued">{t("partial_pay_paid_label")}</s-text>
              <s-heading>{formatCode(successTotal)}</s-heading>
            </s-grid>
          )}

          <s-stack direction="inline" gap="base">
            {failed.length > 0 && (
              <s-button variant="primary" onClick={handleRetry}>
                {allFailed ? t("partial_pay_retry") : t("partial_pay_retry_failed")}
              </s-button>
            )}
            <s-button
              variant={failed.length > 0 ? "secondary" : "primary"}
              onClick={handleCollapse}
            >
              {t("partial_pay_done")}
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>
    );
  }

  // Expanded — payment form
  const validMethods = (info.paymentMethods || []).filter((m) => !m.expired);
  const overdue = parseFloat(info.overdueOutstanding) > 0;

  return (
    <s-section>
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-heading>{t("partial_pay_pay_outstanding_balance")}</s-heading>
          {overdue && (
            <s-badge tone="critical" color="subdued">{t("partial_pay_badge_overdue")}</s-badge>
          )}
        </s-stack>
        <s-divider></s-divider>

        {validMethods.length > 1 && (
          <s-select
            label={t("partial_pay_payment_method")}
            value={paymentMethodId}
            onChange={(e) => setPaymentMethodId(e.target.value)}
            disabled={submitting}
          >
            {validMethods.map((m) => (
              <s-option key={m.fingerprint || m.id} value={m.fingerprint || m.id}>
                {t("partial_pay_card_select_option", {
                  brand: m.brand,
                  digits: m.lastDigits,
                  name: m.name,
                  expiryMonth: m.expiryMonth,
                  expiryYear: m.expiryYear,
                })}
              </s-option>
            ))}
          </s-select>
        )}

        {validMethods.length === 1 && (
          <s-box padding="base" border="base" borderRadius="base">
            <s-stack direction="block" gap="small-100">
              <s-text type="small" color="subdued">{t("partial_pay_payment_method")}</s-text>
              <s-text type="strong">
                {t("partial_pay_card_display", {
                  brand: validMethods[0].brand,
                  digits: validMethods[0].lastDigits,
                  name: validMethods[0].name,
                })}
              </s-text>
            </s-stack>
          </s-box>
        )}

        {validMethods.length === 0 && (
          <s-banner tone="critical">
            <s-text>{t("partial_pay_no_payment_methods")}</s-text>
          </s-banner>
        )}

        <s-text-field
          label={t("partial_pay_amount_to_pay")}
          value={amount}
          onInput={(e) => {
            const v = e.target.value;
            const parsed = parseFloat(v);
            const max = parseFloat(info.totalOutstanding);
            if (!isNaN(parsed) && parsed > max) {
              setAmount(info.totalOutstanding);
            } else {
              setAmount(v);
            }
          }}
          disabled={submitting}
        />

        <s-stack direction="inline" gap="small" alignItems="center">
          <s-text color="subdued">
            {t("partial_pay_max_payable", { amount: formatCode(info.totalOutstanding) })}
          </s-text>
          {overdue && (
            <s-text tone="critical">
              {t("partial_pay_overdue_separated", { amount: formatCode(info.overdueOutstanding) })}
            </s-text>
          )}
        </s-stack>

        {allocations.length > 0 && (
          <s-stack direction="block" gap="small">
            <s-text type="small" color="subdued">{t("partial_pay_orders_label")}</s-text>
            {allocations.slice(0, 10).map((a) => {
              const partial = parseFloat(a.remainingOnOrder) > 0;
              const orderTotal = (
                parseFloat(a.applied) + parseFloat(a.remainingOnOrder)
              ).toFixed(2);
              return (
                <s-box key={a.orderId} padding="base" background="subdued" borderRadius="base">
                  <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
                    <s-stack direction="block" gap="small-100">
                      <s-text type="strong">{a.name}</s-text>
                      {partial ? (
                        <s-text tone="warning">
                          {t("partial_pay_allocated_with_remaining", {
                            allocated: formatCode(a.applied),
                            remaining: formatCode(a.remainingOnOrder),
                          })}
                        </s-text>
                      ) : (
                        <s-text color="subdued">
                          {t("partial_pay_allocated_full", { allocated: formatCode(a.applied) })}
                        </s-text>
                      )}
                    </s-stack>
                    <s-text type="strong">{formatCode(orderTotal)}</s-text>
                  </s-grid>
                </s-box>
              );
            })}
            {allocations.length > 10 && (
              <s-text color="subdued">
                {t("partial_pay_and_more_orders", { count: allocations.length - 10 })}
              </s-text>
            )}
          </s-stack>
        )}

        <s-divider></s-divider>
        <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
          <s-text color="subdued">{t("partial_pay_total")}</s-text>
          <s-heading>{formatCode(amount || "0.00")}</s-heading>
        </s-grid>

        {error && (
          <s-banner tone="critical">
            <s-text>{error}</s-text>
          </s-banner>
        )}

        {submitting && (
          <s-banner tone="info">
            <s-text>{t("partial_pay_processing_payment")}</s-text>
          </s-banner>
        )}

        <s-stack direction="inline" gap="base">
          <s-button
            variant="primary"
            onClick={handleSubmit}
            loading={submitting}
            disabled={submitting || !amount || !paymentMethodId}
          >
            {submitting
              ? t("partial_pay_processing")
              : t("partial_pay_pay_amount", { amount: formatCode(amount || "0.00") })}
          </s-button>
          <s-button onClick={handleCancel} disabled={submitting}>
            {t("partial_pay_not_now")}
          </s-button>
        </s-stack>
      </s-stack>
    </s-section>
  );
}
