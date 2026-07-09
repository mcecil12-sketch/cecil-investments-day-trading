"use client";

import React, { useState } from "react";
import { useTrading } from "@/tradingContext";

export default function SettingsPage() {
  const { settings, updateSettings } = useTrading();

  const [accountSize, setAccountSize] = useState<number>(settings.accountSize);
  const [riskPerTradePct, setRiskPerTradePct] = useState<number>(
    settings.riskPerTradePct
  );
  const [dailyMaxLossR, setDailyMaxLossR] = useState<number>(
    settings.dailyMaxLossR
  );

  const [defaultMoveStopToBreakEvenAtR, setDefaultMoveStopToBreakEvenAtR] =
    useState<string>(
      settings.defaultMoveStopToBreakEvenAtR != null
        ? String(settings.defaultMoveStopToBreakEvenAtR)
        : ""
    );

  const [defaultFirstPartialAtR, setDefaultFirstPartialAtR] = useState<string>(
    settings.defaultFirstPartialAtR != null
      ? String(settings.defaultFirstPartialAtR)
      : ""
  );

  const [defaultFirstPartialPct, setDefaultFirstPartialPct] =
    useState<string>(
      settings.defaultFirstPartialPct != null
        ? String(settings.defaultFirstPartialPct)
        : ""
    );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const parsedAccountSize = Number(accountSize) || 0;
    const parsedRiskPct = Number(riskPerTradePct) || 0;
    const parsedDailyMaxLossR = Number(dailyMaxLossR) || 0;

    const moveStopR = defaultMoveStopToBreakEvenAtR.trim();
    const firstPartialR = defaultFirstPartialAtR.trim();
    const firstPartialPct = defaultFirstPartialPct.trim();

    updateSettings({
      accountSize: parsedAccountSize,
      riskPerTradePct: parsedRiskPct,
      dailyMaxLossR: parsedDailyMaxLossR,
      defaultMoveStopToBreakEvenAtR:
        moveStopR === "" ? null : Number(moveStopR),
      defaultFirstPartialAtR:
        firstPartialR === "" ? null : Number(firstPartialR),
      defaultFirstPartialPct:
        firstPartialPct === "" ? null : Number(firstPartialPct),
    });
  };

  const oneR = settings.oneR;
  const dailyMaxLossDollar = settings.dailyMaxLossR * oneR;

  return (
    <>
      <div className="app-page pb-20">
        <header className="app-header">
          <div className="app-header-title">Settings</div>
          <div className="app-header-subtitle">Account &amp; risk configuration</div>
        </header>

        <section className="mobile-card">
          <div className="text-md" style={{ fontWeight: 600, marginBottom: 8 }}>
            Account &amp; Risk Settings
          </div>
          <form onSubmit={handleSubmit} className="card-body form-grid">
            <div className="form-group">
              <label className="label">Account size ($)</label>
              <input
                type="number"
                className="input"
                value={accountSize}
                onChange={(e) => setAccountSize(Number(e.target.value))}
              />
            </div>

            <div className="form-group">
              <label className="label">Risk per trade (% of account)</label>
              <input
                type="number"
                className="input"
                step="0.1"
                value={riskPerTradePct}
                onChange={(e) => setRiskPerTradePct(Number(e.target.value))}
              />
            </div>

            <div className="form-group">
              <label className="label">Daily max loss (R)</label>
              <input
                type="number"
                className="input"
                step="0.5"
                value={dailyMaxLossR}
                onChange={(e) => setDailyMaxLossR(Number(e.target.value))}
              />
            </div>

            <div className="form-group">
              <label className="label">1R (derived)</label>
              <div className="value read-only">
                ${oneR.toFixed(0)} per 1R
              </div>
            </div>

            <div className="form-group">
              <label className="label">Daily max loss (derived)</label>
              <div className="value read-only">
                {settings.dailyMaxLossR.toFixed(2)}R · $
                {dailyMaxLossDollar.toFixed(0)}
              </div>
            </div>

            <hr className="divider" />

            <div className="form-group">
              <label className="label">
                Move stop to BE at (R)
                <span className="label-sub">
                  Leave blank to disable. Example: 1 = move stop to breakeven
                  at +1R.
                </span>
              </label>
              <input
                type="number"
                className="input"
                step="0.1"
                value={defaultMoveStopToBreakEvenAtR}
                onChange={(e) =>
                  setDefaultMoveStopToBreakEvenAtR(e.target.value)
                }
                placeholder="e.g. 1"
              />
            </div>

            <div className="form-group">
              <label className="label">
                First partial take-profit at (R)
                <span className="label-sub">
                  Leave blank to disable. Example: 2 = consider partial at +2R.
                </span>
              </label>
              <input
                type="number"
                className="input"
                step="0.1"
                value={defaultFirstPartialAtR}
                onChange={(e) => setDefaultFirstPartialAtR(e.target.value)}
                placeholder="e.g. 2"
              />
            </div>

            <div className="form-group">
              <label className="label">
                First partial take-profit size (% of position)
                <span className="label-sub">
                  Leave blank to disable. Example: 50 = close half your size.
                </span>
              </label>
              <input
                type="number"
                className="input"
                step="1"
                min="0"
                max="100"
                value={defaultFirstPartialPct}
                onChange={(e) => setDefaultFirstPartialPct(e.target.value)}
                placeholder="e.g. 50"
              />
            </div>

            <div className="form-actions">
              <button type="submit" className="btn btn-approve">
                Save settings
              </button>
            </div>
          </form>
        </section>
      </div>
    </>
  );
}
