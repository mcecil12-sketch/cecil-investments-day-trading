"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

// A 6-digit PIN is unambiguous the moment it's typed, so it submits right
// away; a shorter (4-5 digit) PIN waits a beat in case the user keeps
// typing, rather than guessing wrong mid-entry.
const AUTO_SUBMIT_DEBOUNCE_MS = 500;

export default function SignInPage() {
  const [pin, setPin] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submittedPinRef = useRef<string | null>(null);

  async function submit(candidate: string) {
    if (loading || submittedPinRef.current === candidate) return;
    submittedPinRef.current = candidate;
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/verify-pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: candidate }),
      });
      const body = await response.json().catch(() => ({}));

      if (!response.ok || !body.success) {
        setError(response.status === 429 ? "Too many attempts — try again later" : "Incorrect PIN");
        setPin("");
        submittedPinRef.current = null;
        setLoading(false);
        return;
      }

      window.location.href = "/";
    } catch {
      setError("Couldn't reach the server — try again");
      submittedPinRef.current = null;
      setLoading(false);
    }
  }

  useEffect(() => {
    if (pin.length < 4) return;
    if (pin.length === 6) {
      submit(pin);
      return;
    }
    const timer = setTimeout(() => submit(pin), AUTO_SUBMIT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin]);

  function handleChange(value: string) {
    const digitsOnly = value.replace(/\D/g, "").slice(0, 6);
    setError(null);
    setPin(digitsOnly);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (pin.length >= 4) submit(pin);
  }

  return (
    <div className="signin-wrap">
      <div className="card signin-card">
        <h1 className="signin-title">Cecil Investments</h1>
        <p className="signin-subtitle">Enter PIN to continue</p>

        <form onSubmit={handleSubmit}>
          <input
            type="number"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="off"
            autoFocus
            maxLength={6}
            className="signin-input"
            value={pin}
            onChange={(e) => handleChange(e.target.value)}
            disabled={loading}
            placeholder="••••"
          />

          {error && <p className="signin-error">{error}</p>}

          <button type="submit" className="btn signin-button" disabled={loading || pin.length < 4}>
            {loading ? "Checking…" : "Unlock"}
          </button>
        </form>
      </div>
    </div>
  );
}
