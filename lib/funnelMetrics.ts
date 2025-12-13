import fs from "fs";
import path from "path";

const FUNNEL_PATH = path.join(process.cwd(), "data", "funnel.json");

type FunnelDay = {
  date: string; // YYYY-MM-DD
  updatedAt: string;
  scansRun: number;
  candidatesFound: number;
  signalsPosted: number;
  signalsReceived: number;
  gptScored: number;
  gptScoredByModel: Record<string, number>;
  qualified: number;
  shownInApp: number;
  approvals: number;
  ordersPlaced: number;
  fills: number;
};

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function emptyDay(date: string): FunnelDay {
  return {
    date,
    updatedAt: new Date().toISOString(),
    scansRun: 0,
    candidatesFound: 0,
    signalsPosted: 0,
    signalsReceived: 0,
    gptScored: 0,
    gptScoredByModel: {},
    qualified: 0,
    shownInApp: 0,
    approvals: 0,
    ordersPlaced: 0,
    fills: 0,
  };
}

function loadAll(): { days: FunnelDay[] } {
  if (!fs.existsSync(FUNNEL_PATH)) return { days: [] };
  try {
    return JSON.parse(fs.readFileSync(FUNNEL_PATH, "utf-8"));
  } catch {
    return { days: [] };
  }
}

function saveAll(data: { days: FunnelDay[] }) {
  fs.writeFileSync(FUNNEL_PATH, JSON.stringify(data, null, 2));
}

function getDay(days: FunnelDay[], date: string) {
  let d = days.find((x) => x.date === date);
  if (!d) {
    d = emptyDay(date);
    days.unshift(d);
  }
  if (days.length > 30) days.length = 30;
  return d;
}

export function bumpFunnel(event: Partial<FunnelDay>) {
  const store = loadAll();
  const date = todayKey();
  const day = getDay(store.days, date);

  for (const [k, v] of Object.entries(event)) {
    if (k === "gptScoredByModel" && v && typeof v === "object") {
      for (const [mk, mv] of Object.entries(v as Record<string, number>)) {
        day.gptScoredByModel[mk] = (day.gptScoredByModel[mk] ?? 0) + (mv ?? 0);
      }
      continue;
    }

    const cur: any = (day as any)[k];
    if (typeof cur === "number") {
      (day as any)[k] = cur + (Number(v) || 0);
    } else if (typeof v === "number") {
      (day as any)[k] = v;
    }
  }

  day.updatedAt = new Date().toISOString();
  saveAll(store);
}

export function readTodayFunnel(): FunnelDay {
  const store = loadAll();
  const date = todayKey();
  const day = getDay(store.days, date);
  return day;
}
