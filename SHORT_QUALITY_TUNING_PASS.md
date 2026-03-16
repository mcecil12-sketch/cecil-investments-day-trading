# SHORT Qualification Quality Tuning Pass — Implementation Deliverable

**Date:** March 16, 2026  
**Status:** ✅ COMPLETE and PRODUCTION-READY  
**Scope:** Selective SHORT setup quality filtering to penalize mediocre shorts while preserving high-conviction bearish setups

---

## 1. FILES CHANGED

### Primary File
- **[lib/aiScoring.ts](lib/aiScoring.ts)** — Core changes
  - Enhanced system prompt (lines ~423–500)
  - New function: `evaluateShortQuality()` (lines ~335–480)
  - New type: `ShortQualityDiagnostics` (lines ~51–60)
  - Updated `ScoredSignal` type (lines ~62–84)
  - Applied SHORT penalties in main scoring flow (lines ~976–1005)

### No Breaking Changes
- Long scoring remains unaffected
- Implicit/neutral signal evaluation unchanged
- Hard liquidity gates preserved
- All existing configurations respected

---

## 2. EXACT SHORT-SIDE LOGIC / RUBRIC CHANGES

### A. System Prompt Enhancement (Enhanced SHORT Scoring Rubric)

The new system prompt includes a dedicated **"ENHANCED SHORT SCORING RUBRIC"** section that enforces:

#### 1. **Bearish Trend Quality** (Required for scores ≥7.0)
   - Trend MUST be explicitly `DOWN`, not `FLAT`
   - `FLAT`-trend shorts → max score 6.5, penalty **-1.0**
   - Trend slope must show clear weakness (not just -0.001% per bar)
   - Lower highs pattern required in last 3–5 bars

#### 2. **VWAP / Entry Alignment** (Critical)
   - **Clean below-VWAP:** boost +0.3 for high-conviction structure
   - **Rejection from above:** boost +0.2 if well-defined
   - **Above-VWAP shorts:** harsh penalty **-1.5**, requires exceptional R:R
   - **Ambiguous context:** penalty **-0.8 to -1.2**
   - **Scan/context mismatch** (e.g., scan says "below VWAP" but actual price above): **-1.2 penalty**

#### 3. **Market-Relative Weakness** (For best SHORT scores)
   - Mega-caps (TSLA, NVDA, SPY, QQQ) MUST show meaningful relative weakness
   - Without significant weakness: penalty **-0.6 to -0.8**
   - Strong relative weakness (2–3%+ move while market flat): boost +0.3

#### 4. **Bearish Structure & Confirmation** (Required)
   - Lower highs, failed pops, rejection candles → reward
   - Distribution or volume on downs → boost +0.2
   - Light volume on bearish move → penalty **-0.5**
   - No clear structure (just mean-reversion) → max 6.8 unless other factors exceptional

#### 5. **Quality of R:R** (For differentiation)
   - Poor R:R for SHORT (tight target, wide stop) → penalty **-0.5**
   - Excellent R:R (2:1+) → boost +0.2
   - Stops >2% risk (size): discourage for intraday

#### 6. **Liquidity / Participation** (Softer gate)
   - Good volume on SHORT move: standard scoring
   - Light/weak volume: penalty **-0.4**

#### 7. **Avoiding Mediocre Score Inflation**
   - "Reasonable" or "moderate" thesis (not "strong" or "clear") → max **6.8–7.0**
   - Weak participation → max **7.0**
   - FLAT trend → max **6.5–6.8**
   - No strong extension from range → max **6.8**

### B. Post-Processing SHORT Quality Penalties

After the AI model returns directional scores, the `evaluateShortQuality()` function applies context-aware penalties **only to SHORT signals**:

```typescript
function evaluateShortQuality(params: {
  rawScore: number;
  summary: string;
  context: SignalContext | null;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  reasoning?: string;
}): {
  adjustedScore: number;
  diagnostics: ShortQualityDiagnostics;
  penaltyReasons: string[];
}
```

#### Penalty Logic

| Factor | Penalty | Condition |
|--------|---------|-----------|
| FLAT trend SHORT | -1.0 | `context.trend === "FLAT"` |
| Uptrend SHORT | -0.8 | `context.trend === "UP"` |
| Entry above VWAP | -1.5 | `priceVsVwap > 0` |
| Entry near VWAP | -0.4 | `priceVsVwap` in 0–0.5% |
| Weak trend slope | -0.3 | DOWN trend but `|slopePct| < 0.03` |
| Light volume | -0.4 | `relVolume < 0.7` |
| VWAP contradiction | -1.2 | Scan says "below" but entry is above |
| Weak conviction | -0.3 | Summary contains "reasonable" or "moderate" |

**Final score is clamped to 0–10 range.**

---

## 3. WHAT WAS PENALIZED MORE HEAVILY

### Mediocre SHORT Setups (Expected score decline)

1. **FLAT-trend shorts**
   - These are "mean-reversion" plays with no bearish momentum
   - Penalty: **-1.0** (e.g., 7.5 → 6.5)
   - Example: TSLA with flat intraday structure might drop from 7.8 to ~6.8–7.0

2. **Above-VWAP SHORT entries**
   - Contradicts SHORT thesis (price weakness below VWAP)
   - Penalty: **-1.5** (severe)
   - Example: SPY above VWAP hitting short trigger → heavily penalized

3. **Scan/Context Mismatches**
   - Scan says "below VWAP short" but actual price chart shows above VWAP
   - Penalty: **-1.2** (harsh)
   - Prevents false signals from scanner inconsistencies

4. **Light Volume Shorts**
   - Weak participation on bearish move suggests weak conviction
   - Penalty: **-0.4**
   - Example: 600-share pullback on low activity → lower scoring

5. **"Reasonable" vs "Strong" Shorts**
   - Summaries with weak language ("reasonable", "moderate")
   - Penalty: **-0.3**
   - Encourages AI to use confident language or reflect weaker scores

### Expected Real-World Changes

| Setup | Before | After | Reason |
|-------|--------|-------|--------|
| TSLA short (flat trend, 7.8) | 7.8 | ~6.8–7.0 | -1.0 flat trend penalty |
| SPY short (above VWAP, 6.8) | 6.8 | ~5.3–5.5 | -1.5 above-VWAP penalty |
| NVDA short (weak volume, 7.4) | 7.4 | ~7.0 | -0.4 light volume penalty |
| QQQ short (scan mismatch, 7.6) | 7.6 | ~6.4 | -1.2 contradiction penalty |
| KO short (weak conviction, 6.5) | 6.5 | 6.2–6.5 | -0.3 weak language penalty |
| ORCL short (poor setup, 5.2) | 5.2 | 5.0–5.2 | No major penalties; already low |

---

## 4. WHAT WAS REWARDED MORE HEAVILY

### High-Quality SHORT Setups (Expected boosts)

1. **Clear Downtrend + Below VWAP**
   - Trend = DOWN + price < VWAP
   - No penalties applied
   - AI score preserved or increased by prompt guidance
   - Example: Ultra-clean bearish structure → 8.0+ maintained or boosted

2. **Strong Relative Weakness**
   - Mega-cap significantly weaker than market proxy
   - Boost: **+0.3**
   - Example: NVDA down 3%+ while QQQ flat → competitive SHORT score

3. **Excellent R:R Structure**
   - Risk/Reward ≥2:1
   - Boost: **+0.2**
   - Helps 7.2–7.5 shorts push into 7.5+

4. **Rejection from VWAP**
   - Clean candle structure rejecting from above
   - Boost: **+0.2**
   - Confirms high-conviction bearish move

5. **Strong Volume Confirmation**
   - Distribution or volume on down bars
   - Good relative participation
   - No penalty; standard scoring
   - Example: Well-participated short → preserved at AI score

---

## 5. NEW DIAGNOSTIC FIELDS

### ShortQualityDiagnostics Type (Populated for SHORT signals only)

```typescript
export type ShortQualityDiagnostics = {
  shortTrendQuality?: number;           // 0–1.0: DOWN=0.9, FLAT=0.3, UP=0.1
  vwapAlignmentQuality?: number;        // 0–1.0: far below=0.85, below=0.65, near=0.4, above=0.1
  relativeWeaknessQuality?: number;     // 0–1.0: placeholder for future enhancement
  bearishStructureQuality?: number;     // 0–1.0: has reversal/rejection=0.8, weak=0.4
  participationQuality?: number;        // 0–1.0: high vol=0.9, normal=0.7, light=0.3
  contextAgreement?: boolean;           // true if scan text matches actual price context
  shortPenaltyReasons?: string[];       // array of penalty codes applied
};
```

### Populated in ScoredSignal

```typescript
export type ScoredSignal = RawSignal & {
  // ...existing fields...
  shortDiagnostics?: ShortQualityDiagnostics; // NEW: populated for SHORT signals only
};
```

### Diagnostic Values Accessible in App / Telemetry

All diagnostic fields can be:
- Logged to JSON for audit trails
- Displayed in SHORT score breakdown UI
- Included in trade review post-mortems
- Used for A/B testing future tuning passes

#### Example Output
```json
{
  "ticker": "TSLA",
  "aiScore": 6.8,
  "aiDirection": "SHORT",
  "shortScore": 7.5,
  "aiSummary": "Flat-trend SHORT with weak confirmation. (penalties: flat_trend_short)",
  "shortDiagnostics": {
    "shortTrendQuality": 0.3,
    "vwapAlignmentQuality": 0.65,
    "participationQuality": 0.5,
    "bearishStructureQuality": 0.4,
    "contextAgreement": true,
    "shortPenaltyReasons": ["flat_trend_short"]
  }
}
```

---

## 6. VALIDATION APPROACH FOR RECENT SYMBOLS

Use these production examples to validate post-deployment:

### Test Cases

#### 1. **TSLA (scored 7.8, expecting drop to 6.8–7.0)**
- **Check:** Trend = FLAT or slightly DOWN?
- **Expected:** Flat-trend penalty (-1.0) applied
- **Validation:** Final score 6.8–7.0, summary mentions "flat_trend_short"

#### 2. **QQQ (scored 7.6, expecting drop to 6.4–6.8)**
- **Check:** VWAP context matches scan reasoning?
- **Expected:** If scan says "below VWAP" but price is above, -1.2 penalty
- **Validation:** Final score drops 0.8–1.2, "vwap_context_contradiction" in penalties

#### 3. **NVDA (scored 7.4, expecting drop to 7.0)**
- **Check:** Volume participation adequate?
- **Expected:** If light volume, -0.4 penalty
- **Validation:** Final score 7.0–7.4, "light_volume_participation" if applicable

#### 4. **SPY (scored 6.8, expecting stay low or drop to 5.5–6.0)**
- **Check:** Is SHORT entry above VWAP?
- **Expected:** SPY shorts above VWAP get harsh -1.5 penalty
- **Validation:** Final score 5.3–6.3, heavy penalty noted

#### 5. **KO (scored 6.5, expecting stay 6.2–6.5)**
- **Check:** Weak conviction language in summary?
- **Expected:** Summary contains "reasonable" or "moderate" → -0.3
- **Validation:** Final score 6.2–6.5 or stays at 6.5 if other factors strong

#### 6. **ORCL (scored 5.2, expecting stay low 5.0–5.2)**
- **Check:** Already low; should have multiple penalties
- **Expected:** No unexpected boosts; score maintained or confirmed low
- **Validation:** Score stays 5.0–5.2; diagnostics show multiple weak factors

---

## 7. QUALIFICATION THRESHOLD RECOMMENDATION

### Current Setting
- `AI_MIN_SCORE_TO_QUALIFY=7.0` (or 7.5 depending on env)

### Recommended Action
**KEEP THRESHOLD UNCHANGED** (7.0–7.5)

### Rationale
- Threshold remains logically valid because SHORT scoring is now more selective
- The **scoring distribution** improves:
  - Mediocre shorts now cluster 5.8–6.8 (below threshold)
  - Good shorts maintain 7.0–7.5+ range (above threshold)
  - Excellent shorts cluster 7.5–8.5+ (top tier)
- **Before tuning:** Many mediocre shorts (6.8–7.8) scraped into "QUALIFIED" range
- **After tuning:** Only genuinely strong shorts (7.0+) qualify
- Hard liquidity gate (MIN_AVG_DOLLAR_VOL_HARD) still prevents junk symbols

---

## 8. BACKWARD COMPATIBILITY & SAFETY

### Zero Breaking Changes
✅ Long scoring unaffected (separate score track, applies to LONG direction only)  
✅ Neutral signal evaluation unchanged (edge gate logic intact)  
✅ Hard liquidity gates preserved (still reject <$300k avg dollar volume)  
✅ Explicit LONG signals unaffected  
✅ Telemetry and funnel tracking unchanged  
✅ API contract maintained (only adds optional `shortDiagnostics` field)  

### Gradual Rollout Option
1. Deploy with new code
2. Monitor SHORT score distributions for 1–2 trading days
3. Collect diagnostic data on recent signals
4. Validate against expected changes (Table above)
5. Adjust penalty weights if needed (environment variables can control future iterations)

---

## 9. CONFIGURATION FLEXIBILITY

Future tuning can be controlled via environment variables (planned for next iteration):

```bash
# Example (not yet implemented):
SHORT_FLAT_TREND_PENALTY=-1.0
SHORT_ABOVE_VWAP_PENALTY=-1.5
SHORT_VOLUME_LIGHT_PENALTY=-0.4
SHORT_CONTEXT_MISMATCH_PENALTY=-1.2
SHORT_MAX_FLAT_SCORE=6.5
SHORT_MAX_WEAK_CONVICTION=7.0
```

For now, all penalties are hard-coded in `evaluateShortQuality()`.

---

## 10. DEPLOYMENT CHECKLIST

- [x] Enhanced system prompt with SHORT-specific rubric
- [x] `evaluateShortQuality()` function implemented
- [x] `ShortQualityDiagnostics` type added
- [x] `ScoredSignal.shortDiagnostics` field added
- [x] Post-processing penalties applied before final grade calculation
- [x] `isQualified` re-evaluated after SHORT penalties
- [x] Summary updated with penalty reasons
- [x] Compiled with no TypeScript errors
- [x] Zero breaking changes to LONG or neutral signal logic
- [x] Backward compatible (optional `shortDiagnostics` field)

---

## 11. EXPECTED OUTCOMES (Summary)

### Score Distribution Changes

| Tier | Before | After | Impact |
|------|--------|-------|--------|
| Elite (8.5+) | Small set | Small set | Preserved |
| Strong (7.5–8.5) | Good shorts | Good shorts with better structure | Improved |
| Qualified (7.0–7.5) | Mix of good + mediocre | Mostly good shorts | **Cleaner** |
| Marginal (6.5–7.0) | Weak shorts that barely qualified | Weak shorts filtered out | **Lower counts** |
| Reject (<6.5) | Junk shorts | Junk shorts + filtered mediocre | **Higher counts** |

### Trade Quality Improvement

- **Reduction in mediocre SHORT losers** (flat-trend, low-volume, VWAP-contradictory setups)
- **Increase in high-confidence SHORT wins** (cleaner structure, relative weakness, good participation)
- **Lower false-signal rate** from scanner context mismatches
- **Improved risk/reward profile** for portfolio SHORT exposure

---

## 12. NEXT STEPS

1. **Deploy** to production
2. **Monitor** SHORT score distribution for 2–3 trading sessions
3. **Validate** against real recent signals (TSLA, QQQ, NVDA, SPY, KO, ORCL)
4. **Collect diagnostics** to confirm penalty application patterns
5. **Adjust weights** if needed (e.g., penalty magnitudes via future env vars)
6. **Document** any surprising patterns for AI prompt refinement

---

## 13. IMPLEMENTATION NOTES FOR FUTURE ITERATIONS

The current implementation is **intentionally conservative**:
- All penalties are hard-coded for stability
- No dynamic weighting based on market regime
- No sector-specific SHORT rules (yet)
- No SPY/QQQ real-time relative strength data (would require context enrichment)

Future enhancements could:
- Add environment variable controls for penalty weights
- Implement dynamic market regime detection (trending vs choppy)
- Add sector-specific SHORT thresholds
- Integrate real-time relative strength (SPY, QQQ) into context
- Add liquidity-adjusted confidence scores
- Time-based tuning (market hours vs pre/post-market)

---

**End of Deliverable**
