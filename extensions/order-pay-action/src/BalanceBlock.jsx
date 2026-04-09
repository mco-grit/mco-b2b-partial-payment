import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useState, useEffect, useCallback, useRef, useMemo } from "preact/hooks";
import { useSessionToken } from "@shopify/ui-extensions/customer-account/preact";

const APP_URL = "https://mco-b2b-partial-payment.onrender.com";

export default async () => {
  render(<BalanceBlock />, document.body);
};

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
      allocations.push({ orderId: o.id, name: o.name, applied: applied.toFixed(2) });
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
        setError(data.error || "Failed to load balance");
        return;
      }
      setInfo(data);
      const validMethod = (data.paymentMethods || []).find((m) => !m.expired);
      if (validMethod) setPaymentMethodId(validMethod.id);
      if (parseFloat(data.totalOutstanding) > 0) {
        setAmount(data.totalOutstanding);
      }
    } catch (e) {
      setError("Failed to load balance");
    } finally {
      setLoading(false);
    }
  }, [sessionToken]);

  useEffect(() => {
    fetchInfo();
  }, [fetchInfo]);

  const allocations = useMemo(() => {
    if (!info || !amount) return [];
    const parsed = parseFloat(amount);
    if (isNaN(parsed) || parsed <= 0) return [];
    return allocate(info.orders, parsed);
  }, [info, amount]);

  const handleSubmit = useCallback(async () => {
    if (submitting) return;
    const parsed = parseFloat(amount);
    if (isNaN(parsed) || parsed <= 0) {
      setError("Enter a valid amount");
      return;
    }
    if (!paymentMethodId) {
      setError("Select a payment method");
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
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error || "Payment failed");
        setSubmitting(false);
        return;
      }
      setResults(data.results || []);
      setSubmitting(false);
    } catch (e) {
      setError("Payment failed");
      setSubmitting(false);
    }
  }, [amount, paymentMethodId, sessionToken, submitting]);

  const handleRetry = useCallback(async () => {
    attemptRef.current += 1;
    setResults(null);
    await fetchInfo();
  }, [fetchInfo]);

  const handleCollapse = useCallback(() => {
    setExpanded(false);
    setResults(null);
    setError("");
    attemptRef.current = 1;
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
        <s-heading>Outstanding balance</s-heading>
        <s-text>You have no outstanding orders.</s-text>
      </s-section>
    );
  }

  // Collapsed widget
  if (!expanded) {
    return (
      <s-section>
        <s-heading>Outstanding balance</s-heading>
        <s-stack direction="block" gap="base">
          <s-text>
            Balance: {info.currencyCode} {info.totalOutstanding}
          </s-text>
          {parseFloat(info.overdueOutstanding) > 0 && (
            <s-text>
              Overdue: {info.currencyCode} {info.overdueOutstanding}
            </s-text>
          )}
          <s-text>
            {info.orders.length} open order{info.orders.length === 1 ? "" : "s"}
          </s-text>
          <s-button kind="primary" onClick={() => setExpanded(true)} onPress={() => setExpanded(true)}>
            Pay outstanding balance
          </s-button>
        </s-stack>
      </s-section>
    );
  }

  // Expanded — results screen
  if (results) {
    const succeeded = results.filter((r) => r.status === "success");
    const failed = results.filter((r) => r.status === "failed");
    return (
      <s-section>
        <s-heading>Payment results</s-heading>
        <s-stack direction="block" gap="base">
          {succeeded.map((r) => (
            <s-text key={r.orderId}>
              ✓ {r.name}: {info.currencyCode} {r.applied} applied
            </s-text>
          ))}
          {failed.map((r) => (
            <s-text key={r.orderId}>
              ✗ {r.name}: failed — {r.error || "unknown error"}
            </s-text>
          ))}
          {failed.length > 0 && (
            <s-button onClick={handleRetry} onPress={handleRetry}>
              Retry failed
            </s-button>
          )}
          <s-button onClick={handleCollapse} onPress={handleCollapse}>
            Done
          </s-button>
        </s-stack>
      </s-section>
    );
  }

  // Expanded — payment form
  const validMethods = (info.paymentMethods || []).filter((m) => !m.expired);

  return (
    <s-section>
      <s-heading>Pay outstanding balance</s-heading>

      <s-stack direction="block" gap="base">
        <s-text>
          Total outstanding: {info.currencyCode} {info.totalOutstanding} across{" "}
          {info.orders.length} order{info.orders.length === 1 ? "" : "s"}
        </s-text>

        {info.orders.map((o) => (
          <s-text key={o.id}>
            {o.name} — {info.currencyCode} {o.outstanding}
            {o.overdue ? " (overdue)" : ""}
          </s-text>
        ))}

        {validMethods.length > 1 && (
          <s-select
            label="Payment method"
            value={paymentMethodId}
            onChange={(e) => setPaymentMethodId(e.target.value)}
            disabled={submitting}
          >
            {validMethods.map((m) => (
              <s-option key={m.id} value={m.id}>
                {m.brand} •••• {m.lastDigits} ({m.name}, exp {m.expiryMonth}/{m.expiryYear})
              </s-option>
            ))}
          </s-select>
        )}

        {validMethods.length === 1 && (
          <s-text>
            Card: {validMethods[0].brand} •••• {validMethods[0].lastDigits} ({validMethods[0].name})
          </s-text>
        )}

        {validMethods.length === 0 && (
          <s-banner status="critical">
            <s-text>No payment methods available.</s-text>
          </s-banner>
        )}

        <s-text-field
          label="Amount to pay"
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
            <s-text>Allocation:</s-text>
            {allocations.map((a) => (
              <s-text key={a.orderId}>
                {info.currencyCode} {a.applied} → {a.name}
              </s-text>
            ))}
          </s-stack>
        )}

        {error && (
          <s-banner status="critical">
            <s-text>{error}</s-text>
          </s-banner>
        )}

        <s-stack direction="inline" gap="base">
          <s-button
            kind="primary"
            onClick={handleSubmit}
            onPress={handleSubmit}
            loading={submitting}
            disabled={submitting || !amount || !paymentMethodId}
          >
            Pay {info.currencyCode} {amount || "0.00"}
          </s-button>
          <s-button onClick={handleCollapse} onPress={handleCollapse} disabled={submitting}>
            Cancel
          </s-button>
        </s-stack>
      </s-stack>
    </s-section>
  );
}
