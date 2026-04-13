"use client";

import { useState, useCallback } from "react";
import {
  TASK_TEMPLATES,
  type TaskTemplate,
  type ChatBridgeResult,
} from "@/lib/agents/chatBridge";

// ─── Types ──────────────────────────────────────────────────────────

interface FormState {
  title: string;
  description: string;
  priority: string;
  taskType: string;
  executionReady: boolean;
  fileHints: string;
  routeHints: string;
  acceptanceCriteria: string;
}

const EMPTY: FormState = {
  title: "",
  description: "",
  priority: "HIGH",
  taskType: "BUGFIX",
  executionReady: true,
  fileHints: "",
  routeHints: "",
  acceptanceCriteria: "",
};

const PRIORITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
const TASK_TYPES = [
  "BUGFIX", "BACKLOG", "OPTIMIZATION", "SELF_HEAL", "OPS",
  "SCORING", "SCANNER", "AUTO_ENTRY", "OTHER",
] as const;

// ─── Component ──────────────────────────────────────────────────────

export function AgentTaskForm({ onSubmitted }: { onSubmitted?: () => void }) {
  const [form, setForm] = useState<FormState>(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ChatBridgeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const set = useCallback(
    (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch })),
    [],
  );

  const applyTemplate = useCallback((tpl: TaskTemplate) => {
    setForm((f) => ({
      ...f,
      taskType: tpl.taskType,
      priority: tpl.priority,
      executionReady: tpl.executionReady,
      description: f.description || tpl.descriptionHint,
    }));
    setResult(null);
    setError(null);
  }, []);

  const submit = useCallback(async () => {
    setError(null);
    setResult(null);
    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        title: form.title.trim(),
        description: form.description.trim(),
        priority: form.priority,
        taskType: form.taskType,
        executionReady: form.executionReady,
        source: "chat_intake",
      };
      if (form.fileHints.trim()) payload.fileHints = form.fileHints.trim();
      if (form.routeHints.trim()) payload.routeHints = form.routeHints.trim();
      if (form.acceptanceCriteria.trim()) payload.acceptanceCriteria = form.acceptanceCriteria.trim();

      const res = await fetch("/api/agents/intake", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = (await res.json()) as ChatBridgeResult & { error?: string };
      if (!res.ok || !data.ok) {
        setError(data.validationError || data.error || `HTTP ${res.status}`);
        return;
      }

      setResult(data);
      if (data.created) setForm(EMPTY);
      onSubmitted?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  }, [form, onSubmitted]);

  // Warn about missing fileHints for patchable tasks
  const patchableTypes = ["BUGFIX", "SCORING", "AUTO_ENTRY", "SELF_HEAL", "OPTIMIZATION"];
  const missingHintsWarning =
    form.executionReady &&
    patchableTypes.includes(form.taskType) &&
    !form.fileHints.trim();

  return (
    <div className="space-y-4">
      {/* Quick templates */}
      <div>
        <div className="text-[10px] uppercase tracking-wide text-[var(--ci-text-muted)] mb-2">
          Quick templates
        </div>
        <div className="flex flex-wrap gap-2">
          {TASK_TEMPLATES.map((tpl) => (
            <button
              key={tpl.key}
              type="button"
              onClick={() => applyTemplate(tpl)}
              className="rounded-lg border border-[var(--ci-border)] bg-black/30 px-3 py-1.5 text-xs text-neutral-300 hover:bg-white/5 active:bg-white/10 transition-colors"
            >
              {tpl.label}
            </button>
          ))}
        </div>
      </div>

      {/* Title */}
      <label className="block">
        <span className="text-[10px] uppercase tracking-wide text-[var(--ci-text-muted)]">
          Title *
        </span>
        <input
          type="text"
          value={form.title}
          onChange={(e) => set({ title: e.target.value })}
          placeholder="Short task title"
          className="mt-1 block w-full rounded-lg border border-[var(--ci-border)] bg-black/30 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-blue-500 focus:outline-none"
        />
      </label>

      {/* Description */}
      <label className="block">
        <span className="text-[10px] uppercase tracking-wide text-[var(--ci-text-muted)]">
          Description *
        </span>
        <textarea
          value={form.description}
          onChange={(e) => set({ description: e.target.value })}
          placeholder="What should the agent do?"
          rows={3}
          className="mt-1 block w-full rounded-lg border border-[var(--ci-border)] bg-black/30 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-blue-500 focus:outline-none resize-y"
        />
      </label>

      {/* Priority + Task type row */}
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-[10px] uppercase tracking-wide text-[var(--ci-text-muted)]">
            Priority
          </span>
          <select
            value={form.priority}
            onChange={(e) => set({ priority: e.target.value })}
            className="mt-1 block w-full rounded-lg border border-[var(--ci-border)] bg-black/30 px-3 py-2 text-sm text-neutral-100 focus:border-blue-500 focus:outline-none"
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-wide text-[var(--ci-text-muted)]">
            Task type
          </span>
          <select
            value={form.taskType}
            onChange={(e) => set({ taskType: e.target.value })}
            className="mt-1 block w-full rounded-lg border border-[var(--ci-border)] bg-black/30 px-3 py-2 text-sm text-neutral-100 focus:border-blue-500 focus:outline-none"
          >
            {TASK_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Execution ready toggle */}
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={form.executionReady}
          onChange={(e) => set({ executionReady: e.target.checked })}
          className="accent-blue-500"
        />
        <span className="text-xs text-neutral-300">Execution ready (auto-trigger when eligible)</span>
      </label>

      {/* File hints */}
      <label className="block">
        <span className="text-[10px] uppercase tracking-wide text-[var(--ci-text-muted)]">
          File hints <span className="normal-case">(comma-separated paths)</span>
        </span>
        <input
          type="text"
          value={form.fileHints}
          onChange={(e) => set({ fileHints: e.target.value })}
          placeholder="lib/aiScoring.ts, lib/agents/store.ts"
          className="mt-1 block w-full rounded-lg border border-[var(--ci-border)] bg-black/30 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-blue-500 focus:outline-none"
        />
      </label>

      {/* Route hints */}
      <label className="block">
        <span className="text-[10px] uppercase tracking-wide text-[var(--ci-text-muted)]">
          Route hints <span className="normal-case">(comma-separated)</span>
        </span>
        <input
          type="text"
          value={form.routeHints}
          onChange={(e) => set({ routeHints: e.target.value })}
          placeholder="app/api/agents/execute/route.ts"
          className="mt-1 block w-full rounded-lg border border-[var(--ci-border)] bg-black/30 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-blue-500 focus:outline-none"
        />
      </label>

      {/* Acceptance criteria */}
      <label className="block">
        <span className="text-[10px] uppercase tracking-wide text-[var(--ci-text-muted)]">
          Acceptance criteria <span className="normal-case">(comma-separated)</span>
        </span>
        <input
          type="text"
          value={form.acceptanceCriteria}
          onChange={(e) => set({ acceptanceCriteria: e.target.value })}
          placeholder="Build passes, AI scores improve by 5%"
          className="mt-1 block w-full rounded-lg border border-[var(--ci-border)] bg-black/30 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-blue-500 focus:outline-none"
        />
      </label>

      {/* File hints warning */}
      {missingHintsWarning && (
        <div className="rounded-lg border border-yellow-700/40 bg-yellow-900/20 px-3 py-2 text-xs text-yellow-300">
          ⚠ Patchable execution-ready tasks strongly benefit from file hints. The executor may block this task without them.
        </div>
      )}

      {/* Submit */}
      <button
        type="button"
        onClick={submit}
        disabled={submitting || !form.title.trim() || !form.description.trim()}
        className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 active:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {submitting ? "Submitting…" : "Create agent task"}
      </button>

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-700/40 bg-red-900/20 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {/* Success result */}
      {result && (
        <div className="rounded-lg border border-[var(--ci-border)] bg-black/20 px-3 py-3 space-y-2">
          {result.deduped ? (
            <div className="text-xs text-yellow-300">
              Duplicate detected — matched existing task.
            </div>
          ) : result.created ? (
            <div className="text-xs text-green-400">Task created successfully.</div>
          ) : null}

          {result.task && (
            <div className="text-xs text-neutral-300 space-y-0.5">
              <div>
                <span className="text-[var(--ci-text-muted)]">ID:</span>{" "}
                <span className="font-mono">{result.task.id.slice(0, 8)}</span>
              </div>
              <div>
                <span className="text-[var(--ci-text-muted)]">Status:</span>{" "}
                {result.task.status}
              </div>
              <div>
                <span className="text-[var(--ci-text-muted)]">Priority:</span>{" "}
                {result.task.priority}
              </div>
            </div>
          )}

          {result.autoExecute && (
            <div className="text-xs">
              {result.autoExecute.triggered ? (
                <span className="text-green-400">Execution auto-triggered.</span>
              ) : result.autoExecute.skippedReason ? (
                <span className="text-yellow-300">
                  Execution skipped: {result.autoExecute.skippedReason.replace(/_/g, " ")}
                </span>
              ) : null}
            </div>
          )}

          {result.queueCounts && (
            <div className="text-[10px] text-[var(--ci-text-muted)]">
              Queue: {result.queueCounts.openCount} open · {result.queueCounts.executionReadyCount} ready · {result.queueCounts.inProgressCount} running · {result.queueCounts.blockedCount} blocked
            </div>
          )}
        </div>
      )}
    </div>
  );
}
