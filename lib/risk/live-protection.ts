/**
 * State-based protection integrity evaluator.
 *
 * Unlike the pure auditProtectionIntegrity() (which only audits current
 * broker state), this module reconciles historical critical incidents with
 * current broker truth, auto-retires stale incidents, and attempts repair
 * before deciding to block execution.
 *
 * Execution is blocked ONLY by current live risk — not by old incidents.
 */

import { fetchBrokerTruth, type BrokerTruth } from "@/lib/broker/truth";
import {
  getCriticalTasks,
  partitionCriticalTasks,
  saveCriticalTask,
  retireStaleCriticalTask,
  type CriticalTask,
} from "@/lib/redis";
import {
  auditProtectionIntegrity,
  type AuditTrade,
  type BrokerPosition,
  type BrokerOrder,
} from "@/lib/risk/protection-integrity";
import { recoverUnprotectedTrades } from "@/lib/risk/protection-recover";
import { isOperationallyOpenTrade } from "@/lib/trades/operational";

// ─── Exported Types ──────────────────────────────────────────────────

export type LiveBlocker = {
  blockerCode: string;
  symbol: string;
  tradeId?: string | null;
  repairAttempted: boolean;
  repairSucceeded: boolean;
  brokerSnapshot?: Record<string, any>;
  dbSnapshot?: Record<string, any>;
  nextAction: string;
  detail: string;
};

export type LiveProtectionResult = {
  ok: boolean;
  evaluatedAt: string;
  liveBlockers: LiveBlocker[];
  retiredStale: Array<{ id: string; code: string; symbol: string; reason: string }>;
  repaired: Array<{ symbol: string; tradeId?: string | null; how: string }>;
  repairAttempts: Array<{ symbol: string; attempted: boolean; succeeded: boolean; error?: string }>;
  summary: string;
  brokerTruthSummary: { positionsCount: number; openOrdersCount: number; error?: string };
  dbTruthSummary: { openTradesCount: number };
};

// ─── Internal Helpers ────────────────────────────────────────────────

function brokerHasPosition(brokerTruth: BrokerTruth, symbol: string): boolean {
  const sym = symbol.toUpperCase();
  return brokerTruth.positions.some(
    (p) => String(p.symbol || "").toUpperCase() === sym && Math.abs(Number(p.qty)) > 0,
  );
}

function brokerHasActiveStop(brokerTruth: BrokerTruth, symbol: string): boolean {
  const sym = symbol.toUpperCase();
  return brokerTruth.openOrders.some(
    (o) =>
      String(o.symbol || "").toUpperCase() === sym &&
      ["stop", "stop_limit"].includes(String(o.type || "").toLowerCase()) &&
      ["new", "accepted", "pending", "held"].includes(String(o.status || "").toLowerCase()),
  );
}

/**
 * Evaluate whether a CriticalTask is still a live blocker given current broker truth.
 *
 * Returns:
 *  "live"    — incident still reflects a real current risk condition
 *  "stale"   — broker/DB state no longer matches this incident — safe to retire
 *  "unknown" — cannot determine from broker truth alone (fail-closed)
 */
function evaluateIncidentStaleness(
  task: CriticalTask,
  brokerTruth: BrokerTruth,
  openTradeSymbols: Set<string>,
): "live" | "stale" | "unknown" {
  const sym = String(task.symbol || "").toUpperCase();
  const code = String(task.incidentCode || "").toUpperCase();

  switch (code) {
    case "FLATTEN_FAILED": {
      // Was trying to flatten — if broker shows no position, the flatten eventually worked
      if (!brokerHasPosition(brokerTruth, sym)) return "stale";
      return "live";
    }

    case "MISSING_STOP": {
      // Missing stop — retire if no position, or if stop is now present
      if (!brokerHasPosition(brokerTruth, sym)) return "stale";
      if (brokerHasActiveStop(brokerTruth, sym)) return "stale";
      return "live";
    }

    case "STOP_REPAIR_FAILED": {
      // Repair previously failed — re-evaluate now
      if (!brokerHasPosition(brokerTruth, sym)) return "stale";
      if (brokerHasActiveStop(brokerTruth, sym)) return "stale";
      return "live";
    }

    case "BROKER_DB_MISMATCH": {
      const dbHasTrade = openTradeSymbols.has(sym);
      const brokerHasPos = brokerHasPosition(brokerTruth, sym);
      // Both flat → mismatch resolved
      if (!dbHasTrade && !brokerHasPos) return "stale";
      // Both have it and stop exists → reconciled
      if (dbHasTrade && brokerHasPos && brokerHasActiveStop(brokerTruth, sym)) return "stale";
      // DB says open but broker shows nothing with a stop — potentially stale DB record
      if (dbHasTrade && !brokerHasPos) return "stale";
      return "live";
    }

    case "STOP_EXPIRED":
    case "STOP_CANCELED":
    case "STOP_DAY_TIF": {
      if (!brokerHasPosition(brokerTruth, sym)) return "stale";
      if (brokerHasActiveStop(brokerTruth, sym)) return "stale";
      return "live";
    }

    default:
      return "unknown";
  }
}

function buildOpenTradeSymbols(trades: Array<Record<string, any>>): Set<string> {
  const syms = new Set<string>();
  for (const t of trades) {
    if (!isOperationallyOpenTrade(t)) continue;
    const sym = String(t?.symbol ?? t?.ticker ?? "").toUpperCase();
    if (sym) syms.add(sym);
  }
  return syms;
}

// ─── Primary Export ──────────────────────────────────────────────────

/**
 * Evaluate current protection integrity using broker-truth reconciliation.
 *
 * Steps:
 * 1. Load unresolved critical incidents from Redis
 * 2. Cross-reference each incident against current broker truth
 * 3. Auto-retire incidents that no longer reflect live risk
 * 4. For remaining live incidents, attempt repair (unless disabled)
 * 5. If no historical incidents, audit current broker positions directly
 * 6. Block execution only if live risk remains after repair attempts
 *
 * @param opts.brokerTruth  - Pre-fetched broker truth (required)
 * @param opts.trades       - All DB trades (for open-symbol lookup)
 * @param opts.attemptRepairs - If true, runs recoverUnprotectedTrades() before blocking
 */
export async function evaluateCurrentProtectionIntegrity(opts: {
  brokerTruth: BrokerTruth;
  trades: Array<Record<string, any>>;
  attemptRepairs?: boolean;
}): Promise<LiveProtectionResult> {
  const now = new Date().toISOString();
  const { brokerTruth, trades, attemptRepairs = true } = opts;

  const retiredStale: LiveProtectionResult["retiredStale"] = [];
  const liveBlockers: LiveBlocker[] = [];
  const repaired: LiveProtectionResult["repaired"] = [];
  const repairAttempts: LiveProtectionResult["repairAttempts"] = [];

  const openTradeSymbols = buildOpenTradeSymbols(trades);
  const dbTruthSummary = { openTradesCount: openTradeSymbols.size };
  const brokerTruthSummary = {
    positionsCount: brokerTruth.positionsCount,
    openOrdersCount: brokerTruth.openOrdersCount,
    error: brokerTruth.error,
  };

  // ── Step 1: Load unresolved critical tasks ───────────────────────
  const allCritical = await getCriticalTasks().catch(() => [] as CriticalTask[]);
  const { blocking: realBlocking } = partitionCriticalTasks(allCritical);

  // ── Path A: No historical incidents — audit live broker state only ──
  if (realBlocking.length === 0) {
    console.log("[live-protection] no unresolved historical critical tasks; auditing live broker state");

    // Short-circuit when broker is fully flat
    if (brokerTruth.positionsCount === 0 && brokerTruth.openOrdersCount === 0) {
      return {
        ok: true,
        evaluatedAt: now,
        liveBlockers: [],
        retiredStale: [],
        repaired: [],
        repairAttempts: [],
        summary: "broker_flat_no_risk",
        brokerTruthSummary,
        dbTruthSummary,
      };
    }

    // Deduplicate by ticker before auditing. When multiple OPEN records exist for the same
    // broker position (e.g. a rich AUTO trade + a ghost broker_backfill placeholder), only
    // the canonical record should be audited. Ghost duplicates must not trigger false MISSING_STOP.
    const canonicalTradeByTicker = new Map<string, Record<string, any>>();
    for (const t of trades) {
      if (!isOperationallyOpenTrade(t)) continue;
      const sym = String(t?.symbol ?? t?.ticker ?? "").toUpperCase();
      if (!sym) continue;
      const existing = canonicalTradeByTicker.get(sym);
      if (!existing) {
        canonicalTradeByTicker.set(sym, t);
        continue;
      }
      // Prefer richest record: signalId > AUTO source > stopOrderId > aiScore
      const richness = (x: Record<string, any>) =>
        (x?.signalId ? 8 : 0) +
        (x?.source === "AUTO" || x?.source === "AUTO-ENTRY" ? 4 : 0) +
        ((x?.stopOrderId || x?.alpacaStopOrderId) ? 2 : 0) +
        (x?.aiScore ? 1 : 0);
      if (richness(t) > richness(existing)) {
        canonicalTradeByTicker.set(sym, t);
      }
    }

    const rawOpenCount = trades.filter((t) => isOperationallyOpenTrade(t)).length;
    if (rawOpenCount > canonicalTradeByTicker.size) {
      console.log("[live-protection] deduplicated open trades for audit", {
        rawOpenCount,
        canonicalCount: canonicalTradeByTicker.size,
        droppedGhosts: rawOpenCount - canonicalTradeByTicker.size,
      });
    }

    const openTradesForAudit: AuditTrade[] = Array.from(canonicalTradeByTicker.values()).map((t) => ({
      id: String(t?.id || ""),
      ticker: String(t?.symbol ?? t?.ticker ?? "").toUpperCase(),
      side: String(t?.side || "LONG").toUpperCase(),
      status: String(t?.status || ""),
      qty: Number(t?.size ?? t?.qty ?? 0),
      stopOrderId: t?.stopOrderId ?? t?.alpacaStopOrderId,
      protectionStatus: t?.protectionStatus,
    }));

    if (openTradesForAudit.length === 0) {
      return {
        ok: true,
        evaluatedAt: now,
        liveBlockers: [],
        retiredStale: [],
        repaired: [],
        repairAttempts: [],
        summary: "no_open_db_trades",
        brokerTruthSummary,
        dbTruthSummary,
      };
    }

    const positions: BrokerPosition[] = Array.isArray(brokerTruth.positions)
      ? brokerTruth.positions
      : [];
    const orders: BrokerOrder[] = Array.isArray(brokerTruth.openOrders)
      ? brokerTruth.openOrders
      : [];

    const audit = auditProtectionIntegrity({
      openTrades: openTradesForAudit,
      brokerPositions: positions,
      brokerOrders: orders,
    });

    if (audit.criticalCount === 0) {
      console.log("[live-protection] live audit: all positions protected", {
        tradeCount: audit.tradeCount,
        protectedCount: audit.protectedCount,
      });
      return {
        ok: true,
        evaluatedAt: now,
        liveBlockers: [],
        retiredStale: [],
        repaired: [],
        repairAttempts: [],
        summary: "all_positions_protected",
        brokerTruthSummary,
        dbTruthSummary,
      };
    }

    // Live audit found critical incidents — attempt repair before blocking
    console.log("[live-protection] live audit critical incidents found", {
      criticalCount: audit.criticalCount,
    });

    if (attemptRepairs) {
      const recoveryResult = await recoverUnprotectedTrades();
      console.log("[live-protection] repair from audit complete", {
        repairSucceeded: recoveryResult.repairSucceeded,
        blockerStillActive: recoveryResult.blockerStillActive,
        resolutionStatus: recoveryResult.resolutionStatus,
      });

      for (const d of recoveryResult.details) {
        repairAttempts.push({
          symbol: d.symbol,
          attempted: d.stopRepairAttempted,
          succeeded: d.stopRepairSucceeded || d.flattenSucceeded,
          error: d.error,
        });
        if (d.stopRepairSucceeded) {
          repaired.push({ symbol: d.symbol, tradeId: d.tradeId, how: "stop_repair" });
          console.log("[live-protection] stale blocker: stop repaired", {
            symbol: d.symbol,
            tradeId: d.tradeId,
          });
        } else if (d.flattenSucceeded) {
          repaired.push({ symbol: d.symbol, tradeId: d.tradeId, how: "flatten" });
          console.log("[live-protection] stale blocker: position flattened", {
            symbol: d.symbol,
            tradeId: d.tradeId,
          });
        }
      }

      if (!recoveryResult.blockerStillActive) {
        return {
          ok: true,
          evaluatedAt: now,
          liveBlockers: [],
          retiredStale: [],
          repaired,
          repairAttempts,
          summary: "repaired_all_live_blockers",
          brokerTruthSummary,
          dbTruthSummary,
        };
      }
    }

    // Build live blockers from audit — repair did not resolve all
    const criticalIncidents = audit.incidents.filter((i) => i.severity === "CRITICAL");
    for (const inc of criticalIncidents) {
      liveBlockers.push({
        blockerCode: inc.code,
        symbol: inc.symbol,
        tradeId: inc.tradeId,
        repairAttempted: attemptRepairs,
        repairSucceeded: false,
        brokerSnapshot: {
          hasPosition: brokerHasPosition(brokerTruth, inc.symbol),
          hasActiveStop: brokerHasActiveStop(brokerTruth, inc.symbol),
        },
        nextAction: "manual_intervention_required",
        detail: inc.detail,
      });
      // Persist as critical incident so agents can see and act on it
      await saveCriticalTask({
        incidentCode: inc.code,
        symbol: inc.symbol,
        severity: "CRITICAL",
        detail: `[live-protection] live blocker: ${inc.detail}`,
      }).catch(() => {});
    }

    console.log("[live-protection] blocking: live audit blockers unresolved", {
      count: liveBlockers.length,
    });

    return {
      ok: false,
      evaluatedAt: now,
      liveBlockers,
      retiredStale: [],
      repaired,
      repairAttempts,
      summary: `${liveBlockers.length} live blocker(s) unresolved after repair attempt`,
      brokerTruthSummary,
      dbTruthSummary,
    };
  }

  // ── Path B: Historical incidents exist — reconcile with broker truth ──

  for (const task of realBlocking) {
    const sym = String(task.symbol || "").toUpperCase();
    const staleness = evaluateIncidentStaleness(task, brokerTruth, openTradeSymbols);

    if (staleness === "stale") {
      console.log("[live-protection] retiring stale blocker", {
        id: task.id,
        code: task.incidentCode,
        symbol: sym,
        createdAt: task.createdAt,
      });
      try {
        await retireStaleCriticalTask(
          task.id,
          `broker_reconciled: ${task.incidentCode} on ${sym} no longer reflects live risk`,
        );
        retiredStale.push({
          id: task.id,
          code: task.incidentCode,
          symbol: sym,
          reason: "broker_reconciled",
        });
      } catch (err) {
        console.warn("[live-protection] retire stale task failed", { id: task.id, err });
      }
      continue;
    }

    // "live" or "unknown" — treat as a live blocker (fail-closed on unknown)
    const brokerHasPos = brokerHasPosition(brokerTruth, sym);
    const brokerHasStop = brokerHasActiveStop(brokerTruth, sym);

    liveBlockers.push({
      blockerCode: task.incidentCode,
      symbol: sym,
      tradeId: task.id,
      repairAttempted: false,
      repairSucceeded: false,
      brokerSnapshot: {
        hasPosition: brokerHasPos,
        hasActiveStop: brokerHasStop,
        positionsCount: brokerTruth.positionsCount,
      },
      dbSnapshot: {
        hasOpenTrade: openTradeSymbols.has(sym),
        openTradesCount: openTradeSymbols.size,
      },
      nextAction:
        staleness === "unknown"
          ? "manual_review_required"
          : "repair_or_resolve_position",
      detail: task.detail,
    });
  }

  if (liveBlockers.length === 0) {
    // All incidents were stale — safe to proceed
    console.log("[live-protection] all incidents retired as stale", {
      retiredCount: retiredStale.length,
    });
    return {
      ok: true,
      evaluatedAt: now,
      liveBlockers: [],
      retiredStale,
      repaired,
      repairAttempts,
      summary: `${retiredStale.length} stale blocker(s) retired; none live`,
      brokerTruthSummary,
      dbTruthSummary,
    };
  }

  // ── Step 4: Attempt repair for live blockers ─────────────────────
  if (attemptRepairs) {
    console.log("[live-protection] live blockers found from historical incidents; attempting repair", {
      count: liveBlockers.length,
      symbols: liveBlockers.map((b) => b.symbol),
    });

    const recoveryResult = await recoverUnprotectedTrades();
    console.log("[live-protection] repair from historical incidents complete", {
      repairSucceeded: recoveryResult.repairSucceeded,
      blockerStillActive: recoveryResult.blockerStillActive,
    });

    for (const d of recoveryResult.details) {
      repairAttempts.push({
        symbol: d.symbol,
        attempted: d.stopRepairAttempted,
        succeeded: d.stopRepairSucceeded || d.flattenSucceeded,
        error: d.error,
      });
      if (d.stopRepairSucceeded) {
        repaired.push({ symbol: d.symbol, tradeId: d.tradeId, how: "stop_repair" });
        console.log("[live-protection] stop repaired for historical blocker", { symbol: d.symbol });
      } else if (d.flattenSucceeded) {
        repaired.push({ symbol: d.symbol, tradeId: d.tradeId, how: "flatten" });
        console.log("[live-protection] position flattened for historical blocker", {
          symbol: d.symbol,
        });
      }
    }

    // Update repair flags on live blocker entries for diagnostic output
    for (const b of liveBlockers) {
      b.repairAttempted = true;
      const repairDetail = recoveryResult.details.find(
        (d) => d.symbol.toUpperCase() === b.symbol.toUpperCase(),
      );
      if (repairDetail) {
        b.repairSucceeded = repairDetail.stopRepairSucceeded || repairDetail.flattenSucceeded;
        if (repairDetail.error) {
          b.detail = `${b.detail} [repair_error: ${repairDetail.error}]`;
        }
      }
    }

    if (!recoveryResult.blockerStillActive) {
      // Re-check incidents post-repair; try to retire any that are now stale
      for (const task of realBlocking) {
        const sym = String(task.symbol || "").toUpperCase();
        if (!brokerHasPosition(brokerTruth, sym)) {
          try {
            await retireStaleCriticalTask(task.id, "repaired_by_live_protection");
            retiredStale.push({
              id: task.id,
              code: task.incidentCode,
              symbol: sym,
              reason: "repaired",
            });
          } catch {}
        }
      }

      return {
        ok: true,
        evaluatedAt: now,
        liveBlockers: [],
        retiredStale,
        repaired,
        repairAttempts,
        summary: "all_live_blockers_repaired",
        brokerTruthSummary,
        dbTruthSummary,
      };
    }
  }

  // ── Step 5: Escalate — persist fresh incidents for unresolved blockers ──
  const unrepairedBlockers = liveBlockers.filter((b) => !b.repairSucceeded);
  for (const b of unrepairedBlockers) {
    await saveCriticalTask({
      incidentCode: b.blockerCode,
      symbol: b.symbol,
      severity: "CRITICAL",
      detail: `[live-protection] Escalation: repair failed. repairAttempted=${b.repairAttempted}. ${b.detail}`,
    }).catch(() => {});
  }

  console.log("[live-protection] blocking: live blockers remain after repair", {
    count: unrepairedBlockers.length,
    retiredStale: retiredStale.length,
    repaired: repaired.length,
  });

  return {
    ok: false,
    evaluatedAt: now,
    liveBlockers: unrepairedBlockers,
    retiredStale,
    repaired,
    repairAttempts,
    summary: `${unrepairedBlockers.length} live blocker(s) remain after repair: ${unrepairedBlockers.map((b) => `${b.blockerCode}:${b.symbol}`).join(", ")}`,
    brokerTruthSummary,
    dbTruthSummary,
  };
}
