import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useState, useEffect, useCallback, useRef, useMemo } from "preact/hooks";
import { useSessionToken } from "@shopify/ui-extensions/customer-account/preact";

const APP_URL = "https://mco-b2b-partial-payment.onrender.com";

export default async () => {
  render(<BalanceBlock />, document.body);
};

function t(key, vars) {
  try {
    return shopify.i18n.translate(key, vars);
  } catch (e) {
    return key;
  }
}

function friendlyError(raw) {
  if (!raw) return t("errorGeneric");
  const lower = raw.toLowerCase();
  if (lower.includes("currency") && lower.includes("match")) return t("errorCurrencyMismatch");
  if (lower.includes("declined") || lower.includes("balance did not decrease")) return t("errorCardDeclined");
  if (lower.includes("no matching payment method")) return t("errorNoMatchingCard");
  if (lower.includes("job not found") || lower.includes("no job")) return t("errorGeneric");
  // If it looks like a raw API message (long, technical), replace it
  if (raw.length > 80 || /[A-Z]{2,}/.test(raw)) return t("errorGeneric");
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
        setError(data.error || t("failedToLoadBalance"));
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
      setError(t("failedToLoadBalance"));
    } finally {
      setLoading(false);
    }
  }, [sessionToken]);

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

  const handleSubmit = useCallback(async () => {
    if (submitting) return;
    const parsed = parseFloat(amount);
    if (isNaN(parsed) || parsed <= 0) {
      setError(t("enterValidAmount"));
      return;
    }
    if (!paymentMethodId) {
      setError(t("selectPaymentMethod"));
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
        setError(friendlyError(data.error));
        setSubmitting(false);
        return;
      }
      setResults(data.results || []);
      setSubmitting(false);
    } catch (e) {
      setError(t("paymentFailed"));
      setSubmitting(false);
    }
  }, [amount, paymentMethodId, sessionToken, submitting]);

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
        <s-banner status="critical">
          <s-text>{error}</s-text>
        </s-banner>
      </s-section>
    );
  }

  if (!info || parseFloat(info.totalOutstanding) <= 0) {
    return (
      <s-section>
        <s-heading>{t("outstandingBalance")}</s-heading>
        <s-text>{t("noOutstandingOrders")}</s-text>
      </s-section>
    );
  }

  // Collapsed widget
  if (!expanded) {
    return (
      <s-section>
        <s-heading>{t("outstandingBalance")}</s-heading>
        <s-stack direction="block" gap="base">
          <s-text>
            {t("balance", { amount: formatMoney(info.totalOutstanding) })}
          </s-text>
          {parseFloat(info.overdueOutstanding) > 0 && (
            <s-text>
              {t("overdue", { amount: formatMoney(info.overdueOutstanding) })}
            </s-text>
          )}
          <s-text>
            {info.orders.length === 1
              ? t("openOrders", { count: info.orders.length })
              : t("openOrdersPlural", { count: info.orders.length })}
          </s-text>
          <s-button variant="primary" onClick={() => setExpanded(true)}>
            {t("payOutstandingBalance")}
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
    const allFailed = succeeded.length === 0 && failed.length > 0;

    return (
      <s-section>
        <s-heading>{t("paymentResults")}</s-heading>
        <s-stack direction="block" gap="base">
          <s-text>
            {t("succeededCount", { count: succeeded.length, amount: formatMoney(successTotal) })}
            {failed.length > 0 ? `, ${t("failedCount", { count: failed.length })}` : ""}
            {pending.length > 0 ? `, ${t("pendingCount", { count: pending.length })}` : ""}
          </s-text>

          {failed.length > 0 && (
            <s-stack direction="block" gap="tight">
              {allFailed && (
                <s-banner status="critical">
                  <s-text>{t("overallPaymentError")}</s-text>
                </s-banner>
              )}
              <s-text>{t("failedLabel")}</s-text>
              {failed.slice(0, 10).map((r) => (
                <s-text key={r.orderId}>
                  {t("failedItem", { name: r.name, error: friendlyError(r.error) })}
                </s-text>
              ))}
              {failed.length > 10 && (
                <s-text>{t("andMore", { count: failed.length - 10 })}</s-text>
              )}
            </s-stack>
          )}

          {succeeded.length > 0 && succeeded.length <= 10 && (
            <s-stack direction="block" gap="tight">
              {succeeded.map((r) => (
                <s-text key={r.orderId}>
                  {t("succeededItem", { name: r.name, amount: formatMoney(r.applied) })}
                  {r.remainingOutstanding && parseFloat(r.remainingOutstanding) > 0
                    ? ` — ${t("remainingOnOrder", { amount: formatMoney(r.remainingOutstanding) })}`
                    : ` — ${t("fullyPaid")}`}
                </s-text>
              ))}
            </s-stack>
          )}

          <s-grid gridTemplateColumns={failed.length > 0 ? "1fr auto auto" : "1fr auto"} gap="base">
            <s-grid-item />
            {failed.length > 0 && (
              <s-grid-item>
                <s-button onClick={handleRetry}>
                  {allFailed ? t("retry") : t("retryFailed")}
                </s-button>
              </s-grid-item>
            )}
            <s-grid-item>
              <s-button variant="primary" onClick={handleCollapse}>
                {t("done")}
              </s-button>
            </s-grid-item>
          </s-grid>
        </s-stack>
      </s-section>
    );
  }

  // Expanded — payment form
  const validMethods = (info.paymentMethods || []).filter((m) => !m.expired);

  return (
    <s-section>
      <s-heading>{t("payOutstandingBalance")}</s-heading>

      <s-stack direction="block" gap="base">
        <s-text>
          {info.orders.length === 1
            ? t("totalOutstandingAcross", { amount: formatMoney(info.totalOutstanding), count: info.orders.length })
            : t("totalOutstandingAcrossPlural", { amount: formatMoney(info.totalOutstanding), count: info.orders.length })}
          {parseFloat(info.overdueOutstanding) > 0
            ? ` ${t("overdueParenthetical", { amount: formatMoney(info.overdueOutstanding) })}`
            : ""}
        </s-text>

        {validMethods.length > 1 && (
          <s-select
            label={t("paymentMethod")}
            value={paymentMethodId}
            onChange={(e) => setPaymentMethodId(e.target.value)}
            disabled={submitting}
          >
            {validMethods.map((m) => (
              <s-option key={m.fingerprint || m.id} value={m.fingerprint || m.id}>
                {t("cardSelectOption", {
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
          <s-text>
            {t("cardDisplay", {
              brand: validMethods[0].brand,
              digits: validMethods[0].lastDigits,
              name: validMethods[0].name,
            })}
          </s-text>
        )}

        {validMethods.length === 0 && (
          <s-banner status="critical">
            <s-text>{t("noPaymentMethods")}</s-text>
          </s-banner>
        )}

        <s-text-field
          label={t("amountToPay")}
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

        {allocations.length > 0 && (
          <s-stack direction="block" gap="tight">
            <s-text>{t("allocationLabel", { count: allocations.length })}</s-text>
            {allocations.slice(0, 5).map((a) => (
              <s-text key={a.orderId}>
                {parseFloat(a.remainingOnOrder) > 0
                  ? t("allocationItemWithRemaining", {
                      amount: formatMoney(a.applied),
                      name: a.name,
                      remaining: formatMoney(a.remainingOnOrder),
                    })
                  : t("allocationItem", { amount: formatMoney(a.applied), name: a.name })}
              </s-text>
            ))}
            {allocations.length > 5 && (
              <s-text>{t("andMoreOrders", { count: allocations.length - 5 })}</s-text>
            )}
          </s-stack>
        )}

        {error && (
          <s-banner status="critical">
            <s-text>{error}</s-text>
          </s-banner>
        )}

        {submitting && (
          <s-banner status="warning">
            <s-text>{t("processingPayment")}</s-text>
          </s-banner>
        )}

        <s-stack direction="inline" gap="base">
          <s-button onClick={handleCancel} disabled={submitting}>
            {t("notNow")}
          </s-button>
          <s-button
            variant="primary"
            onClick={handleSubmit}
            loading={submitting}
            disabled={submitting || !amount || !paymentMethodId}
          >
            {t("payAmount", { amount: formatMoney(amount || "0.00") })}
          </s-button>
        </s-stack>
      </s-stack>
    </s-section>
  );
}
