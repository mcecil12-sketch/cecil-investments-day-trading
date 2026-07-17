import { prisma } from "@/lib/prisma";
import { formatDate } from "@/lib/format";

const PUSHOVER_API_URL = "https://api.pushover.net/1/messages.json";
const MAX_MESSAGE_LENGTH = 1024;

export interface WeeklyBriefNotificationResult {
  sent: boolean;
  reason?: string;
}

interface ActionItemLike {
  priority: number;
  action: string;
  rationale: string;
}

function urgencyLabel(priority: number): string {
  if (priority === 1) return "[Urgent]";
  if (priority <= 3) return "[High]";
  return "[Watch]";
}

function truncate(message: string, maxLength: number): string {
  if (message.length <= maxLength) return message;
  return `${message.slice(0, maxLength - 1)}…`;
}

function buildMessage(headline: string, items: ActionItemLike[]): string {
  const lines = [
    headline,
    "",
    ...items.slice(0, 3).map((item) => `${urgencyLabel(item.priority)} ${item.action} — ${item.rationale}`),
  ];
  return truncate(lines.join("\n"), MAX_MESSAGE_LENGTH);
}

async function sendPushover(params: { user: string; token: string; title: string; message: string }): Promise<WeeklyBriefNotificationResult> {
  const body = new URLSearchParams({
    token: params.token,
    user: params.user,
    title: params.title,
    message: params.message,
    priority: "1",
    sound: "cashregister",
  });

  const resp = await fetch(PUSHOVER_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return { sent: false, reason: `Pushover API error (${resp.status}): ${text}` };
  }
  return { sent: true };
}

/**
 * Sends a Pushover push notification for the latest WeeklyBrief. Skips
 * silently (rather than throwing) when PUSHOVER_USER_KEY / a token aren't
 * configured, since this is a nice-to-have on top of the in-app CIO Weekly
 * Action List, not a hard dependency for the agent pipeline. Falls back to
 * the latest agent run's top action item when no weekly brief exists yet.
 */
export async function sendWeeklyBriefNotification(): Promise<WeeklyBriefNotificationResult> {
  const user = process.env.PUSHOVER_USER_KEY;
  const token = process.env.PUSHOVER_API_TOKEN || process.env.PUSHOVER_APP_TOKEN;
  if (!user || !token) {
    return { sent: false, reason: "PUSHOVER_USER_KEY or PUSHOVER_API_TOKEN/PUSHOVER_APP_TOKEN is not configured" };
  }

  const weeklyBrief = await prisma.weeklyBrief.findFirst({
    orderBy: { weekOf: "desc" },
    include: { actionItems: { orderBy: { priority: "asc" } } },
  });

  if (weeklyBrief && weeklyBrief.actionItems.length > 0) {
    return sendPushover({
      user,
      token,
      title: `Portfolio Brief — ${formatDate(weeklyBrief.weekOf)}`,
      message: buildMessage(weeklyBrief.cioSummary, weeklyBrief.actionItems),
    });
  }

  const latestRun = await prisma.agentRun.findFirst({
    where: { status: "COMPLETE", actionItems: { some: {} } },
    orderBy: { startedAt: "desc" },
    include: { actionItems: { orderBy: { priority: "asc" }, take: 1 } },
  });
  const topItem = latestRun?.actionItems[0];
  if (!topItem) {
    return { sent: false, reason: "No weekly brief or agent run action items available" };
  }

  return sendPushover({
    user,
    token,
    title: `Portfolio Brief — ${formatDate(new Date())}`,
    message: truncate(
      `No weekly brief compiled yet. Latest signal: ${urgencyLabel(topItem.priority)} ${topItem.action} — ${topItem.rationale}`,
      MAX_MESSAGE_LENGTH,
    ),
  });
}
