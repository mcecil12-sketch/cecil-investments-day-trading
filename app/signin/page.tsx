"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

const MIN_PIN_LENGTH = 4;
const MAX_PIN_LENGTH = 6;

export default function SignInPage() {
  const [pin, setPin] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submittedPinRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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
    // Only auto-submit once the PIN can't get any longer — anything short of
    // that could still be mid-entry of a 5- or 6-digit PIN, so a 4-5 digit
    // count relies on the Unlock button (or Enter) instead of guessing.
    if (pin.length === MAX_PIN_LENGTH) submit(pin);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin]);

  function handleChange(value: string) {
    const digitsOnly = value.replace(/\D/g, "").slice(0, MAX_PIN_LENGTH);
    setError(null);
    setPin(digitsOnly);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (pin.length >= MIN_PIN_LENGTH) submit(pin);
  }

  const dotCount = Math.max(MIN_PIN_LENGTH, pin.length);
  const dots = Array.from({ length: dotCount }, (_, i) => i < pin.length);

  return (
    <div className="signin-wrap">
      <div className="card signin-card">
        <h1 className="signin-title">Cecil Investments</h1>
        <p className="signin-subtitle">Enter PIN to continue</p>

        <form onSubmit={handleSubmit}>
          <div className="signin-dots" onClick={() => inputRef.current?.focus()}>
            {dots.map((filled, i) => (
              <span key={i} className={filled ? "signin-dot signin-dot-filled" : "signin-dot"} />
            ))}
          </div>

          <input
            ref={inputRef}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="off"
            autoFocus
            maxLength={MAX_PIN_LENGTH}
            className="signin-input signin-input-hidden"
            value={pin}
            onChange={(e) => handleChange(e.target.value)}
            disabled={loading}
            aria-label="PIN"
          />

          {error && <p className="signin-error">{error}</p>}

          <button
            type="submit"
            className="btn signin-button"
            disabled={loading || pin.length < MIN_PIN_LENGTH}
          >
            {loading ? "Checking…" : "Unlock"}
          </button>
        </form>
      </div>
    </div>
  );
}
