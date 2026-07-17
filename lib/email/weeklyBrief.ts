import { Resend } from "resend";
import { prisma } from "@/lib/prisma";
import { formatDate } from "@/lib/format";
import type { ActionItem, Account } from "@/lib/generated/prisma";

/** Resend's shared testing sender — works without verifying a domain. Swap for a verified "you@yourdomain.com" sender once one is set up. */
const FROM_ADDRESS = "Cecil Investments CIO <onboarding@resend.dev>";

export interface WeeklyBriefEmailResult {
  sent: boolean;
  reason?: string;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
}

function renderActionItemRow(item: ActionItem & { account: Account | null }): string {
  const impactLine = [item.expectedImpact, item.account?.name]
    .filter((part): part is string => Boolean(part))
    .map(escapeHtml)
    .join(" — ");
  return `
    <tr>
      <td style="padding:12px 0;border-bottom:1px solid #e5e5e5;vertical-align:top;width:28px;color:#888;font-weight:600;">${item.priority}</td>
      <td style="padding:12px 0;border-bottom:1px solid #e5e5e5;">
        <div style="font-weight:600;color:#111;">${escapeHtml(item.action)}</div>
        <div style="color:#555;font-size:13px;margin-top:2px;">${escapeHtml(item.rationale)}</div>
        ${impactLine ? `<div style="color:#888;font-size:12px;margin-top:2px;">${impactLine}</div>` : ""}
      </td>
    </tr>`;
}

function renderHtml(weekOf: Date, cioSummary: string, actionItems: Array<ActionItem & { account: Account | null }>): string {
  return `
    <div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;color:#111;">
      <h2 style="margin-bottom:4px;">Weekly CIO Brief</h2>
      <p style="color:#888;font-size:13px;margin-top:0;">Week of ${formatDate(weekOf)}</p>
      <p style="font-size:15px;line-height:1.5;">${escapeHtml(cioSummary)}</p>
      <table style="width:100%;border-collapse:collapse;margin-top:16px;">
        <tbody>
          ${actionItems.map(renderActionItemRow).join("")}
        </tbody>
      </table>
    </div>`;
}

/**
 * Sends the latest WeeklyBrief via Resend to TO_EMAIL. No-ops (rather than
 * throwing) when RESEND_API_KEY/TO_EMAIL aren't configured or there's no
 * brief yet, since email delivery is a nice-to-have on top of the in-app
 * CIO Weekly Action List, not a hard dependency for the agent pipeline.
 */
export async function sendWeeklyBriefEmail(): Promise<WeeklyBriefEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const toEmail = process.env.TO_EMAIL;
  if (!apiKey || !toEmail) {
    return { sent: false, reason: "RESEND_API_KEY or TO_EMAIL is not configured" };
  }

  const weeklyBrief = await prisma.weeklyBrief.findFirst({
    orderBy: { weekOf: "desc" },
    include: { actionItems: { orderBy: { priority: "asc" }, include: { account: true } } },
  });
  if (!weeklyBrief) {
    return { sent: false, reason: "No weekly brief to send yet" };
  }

  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: toEmail,
    subject: `Weekly CIO Brief — Week of ${formatDate(weeklyBrief.weekOf)}`,
    html: renderHtml(weeklyBrief.weekOf, weeklyBrief.cioSummary, weeklyBrief.actionItems),
  });

  if (error) {
    return { sent: false, reason: error.message };
  }
  return { sent: true };
}
