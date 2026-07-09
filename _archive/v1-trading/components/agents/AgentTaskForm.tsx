"use client";

import { useState, useCallback } from "react";
import { TASK_TEMPLATES, type TaskTemplate } from "@/lib/agents/chatBridge";
import { linesToArray } from "./parseLines";

// ─── Constants ──────────────────────────────────────────────────────

const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
const TASK_TYPES = [
  "BUGFIX", "BACKLOG", "OPTIMIZATION", "SELF_HEAL", "OPS",
  "SCORING", "SCANNER", "AUTO_ENTRY", "OTHER",
] as const;

const PATCHABLE_TYPES = new Set([
  "BUGFIX", "SCORING", "AUTO_ENTRY", "SELF_HEAL", "OPTIMIZATION",
]);

// ─── Form state ─────────────────────────────────────────────────────

interface FormState {
  title: string;
  description: string;
  priority: string;
  taskType: string;
  executionReady: boolean;
  acceptanceCriteria: string;
  fileHints: string;
  routeHints: string;
}

const EMPTY: FormState = {
  title: "",
  description: "",
  priority: "MEDIUM",
  taskType: "OPS",
  executionReady: false,
  acceptanceCriteria: "",
  fileHints: "",
  routeHints: "",
};

// ─── Intake response shape ──────────────────────────────────────────

interface IntakeResponse {
  ok: boolean;
  created?: boolean;
  deduped?: boolean;
  error?: string;
  field?: string;
  task?: {
    id: string;
    title: string;
    status: string;
    priority: string;
    taskType: string;
    executionReady: boolean;
  };
  queueCounts?: {
    openCount: number;
    executionReadyCount: number;
    inProgressCount: number;
    blockedCount: number;
    selectedCount: number;
  };
  autoExecute?: {
    attempted: boolean;
    triggered: boolean;
    skippedReason: string | null;
  };
  duplicateMatchId?: string;
}

// ─── Component ──────────────────────────────────────────────────────

export function AgentTaskForm({ onSubmitted }: { onSubmitted?: () => void }) {
  const [form, setForm] = useState<FormState>(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<IntakeResponse | null>(null);
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
      const acceptanceCriteria = linesToArray(form.acceptanceCriteria);
      const fileHints = linesToArray(form.fileHints);
      const routeHints = linesToArray(form.routeHints);

      const payload: Record<string, unknown> = {
        title: form.title.trim(),
        description: form.description.trim(),
        priority: form.priority,
        taskType: form.taskType,
        executionReady: form.executionReady,
        source: "chat_intake",
      };
      if (acceptanceCriteria.length) payload.acceptanceCriteria = acceptanceCriteria;
      if (fileHints.length) payload.fileHints = fileHints;
      if (routeHints.length) payload.routeHints = routeHints;

      const res = await fetch("/api/agents/intake", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data: IntakeResponse = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error || `HTTP ${res.status}`);
        return;
      }

      setResult(data);
      if (data.created) setForm(EMPTY);

      // If auto-execution triggered, refresh state immediately
      if (data.autoExecute?.triggered) {
        onSubmitted?.();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  }, [form, onSubmitted]);

  // Pre-submit warning
  const showFileHintWarning =
    form.executionReady &&
    PATCHABLE_TYPES.has(form.taskType) &&
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
      <Field label="Title *">
        <input
          type="text"
          value={form.title}
          onChange={(e) => set({ title: e.target.value })}
          placeholder="Short task title"
          className={INPUT_CLS}
        />
      </Field>

      {/* Description */}
      <Field label="Description *">
        <textarea
          value={form.description}
          onChange={(e) => set({ description: e.target.value })}
          placeholder="What should the agent do?"
          rows={3}
          className={INPUT_CLS + " resize-y"}
        />
      </Field>

      {/* Priority + Task type */}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Priority">
          <select
            value={form.priority}
            onChange={(e) => set({ priority: e.target.value })}
            className={INPUT_CLS}
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </Field>
        <Field label="Task type">
          <select
            value={form.taskType}
            onChange={(e) => set({ taskType: e.target.value })}
            className={INPUT_CLS}
          >
            {TASK_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </Field>
      </div>

      {/* Execution ready */}
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={form.executionReady}
          onChange={(e) => set({ executionReady: e.target.checked })}
          className="accent-blue-500"
        />
        <span className="text-xs text-neutral-300">
          Execution ready (auto-trigger when eligible)
        </span>
      </label>

      {/* Acceptance criteria */}
      <Field label="Acceptance criteria" hint="one per line">
        <textarea
          value={form.acceptanceCriteria}
          onChange={(e) => set({ acceptanceCriteria: e.target.value })}
          placeholder={"Build passes\nAI scores improve by 5%"}
          rows={2}
          className={INPUT_CLS + " resize-y"}
        />
      </Field>

      {/* File hints */}
      <Field label="File hints" hint="one per line">
        <textarea
          value={form.fileHints}
          onChange={(e) => set({ fileHints: e.target.value })}
          placeholder={"lib/aiScoring.ts\nlib/agents/store.ts"}
          rows={2}
          className={INPUT_CLS + " resize-y"}
        />
      </Field>

      {/* Route hints */}
      <Field label="Route hints" hint="one per line">
        <textarea
          value={form.routeHints}
          onChange={(e) => set({ routeHints: e.target.value })}
          placeholder="app/api/agents/execute/route.ts"
          rows={2}
          className={INPUT_CLS + " resize-y"}
        />
      </Field>

      {/* Warning: missing file hints */}
      {showFileHintWarning && (
        <Banner color="yellow">
          Patchable execution-ready tasks strongly benefit from file hints. The executor may block this task without them.
        </Banner>
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

      {/* Error banner */}
      {error && <Banner color="red">{error}</Banner>}

      {/* Success result */}
      {result && (
        <div className="rounded-xl border border-[var(--ci-border)] bg-black/20 px-4 py-3 space-y-2">
          {result.deduped ? (
            <Banner color="yellow">
              Duplicate detected — matched existing task {result.duplicateMatchId?.slice(0, 8)}.
            </Banner>
          ) : result.created ? (
            <Banner color="green">Task created successfully.</Banner>
          ) : null}

          {result.task && (
            <div className="text-xs text-neutral-300 space-y-0.5">
              <Row label="ID" value={result.task.id.slice(0, 8)} mono />
              <Row label="Status" value={result.task.status} />
              <Row label="Priority" value={result.task.priority} />
              <Row label="Type" value={result.task.taskType} />
            </div>
          )}

          {result.autoExecute && (
            <div className="text-xs">
              {result.autoExecute.triggered ? (
                <span className="text-green-400">Execution auto-triggered.</span>
              ) : result.autoExecute.attempted ? (
                <span className="text-yellow-300">
                  Execution skipped: {result.autoExecute.skippedReason?.replace(/_/g, " ")}
                </span>
              ) : (
                <span className="text-neutral-500">Auto-execute not attempted.</span>
              )}
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

// ─── Shared UI pieces ───────────────────────────────────────────────

const INPUT_CLS =
  "mt-1 block w-full rounded-lg border border-[var(--ci-border)] bg-black/30 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-blue-500 focus:outline-none";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wide text-[var(--ci-text-muted)]">
        {label}
        {hint && <span className="normal-case text-neutral-600 ml-1">({hint})</span>}
      </span>
      {children}
    </label>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <span className="text-[var(--ci-text-muted)]">{label}:</span>{" "}
      <span className={mono ? "font-mono" : ""}>{value}</span>
    </div>
  );
}

function Banner({ color, children }: { color: "red" | "green" | "yellow"; children: React.ReactNode }) {
  const cls: Record<string, string> = {
    red: "border-red-700/40 bg-red-900/20 text-red-300",
    green: "border-emerald-700/40 bg-emerald-900/20 text-emerald-300",
    yellow: "border-yellow-700/40 bg-yellow-900/20 text-yellow-300",
  };
  return (
    <div className={`rounded-lg border px-3 py-2 text-xs ${cls[color]}`}>
      {children}
    </div>
  );
}
