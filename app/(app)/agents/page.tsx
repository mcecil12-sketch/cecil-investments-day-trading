"use client";

import { useState } from "react";
import { AgentTaskForm } from "@/components/AgentTaskForm";
import { AgentStatusPanel } from "@/components/AgentStatusPanel";

export default function AgentsPage() {
  const [tab, setTab] = useState<"status" | "create">("status");
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <div className="min-h-screen px-4 py-6 pb-28 max-w-xl mx-auto space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-lg font-semibold text-neutral-100">Agent command center</h1>
        <p className="text-xs text-neutral-500 mt-0.5">
          Create tasks, trigger execution, and monitor agent state.
        </p>
      </div>

      {/* Tab switcher */}
      <div className="flex rounded-lg border border-[var(--ci-border)] overflow-hidden">
        <button
          type="button"
          onClick={() => setTab("status")}
          className={`flex-1 py-2 text-xs font-medium transition-colors ${
            tab === "status"
              ? "bg-white/10 text-neutral-100"
              : "bg-black/20 text-neutral-500 hover:text-neutral-300"
          }`}
        >
          Status
        </button>
        <button
          type="button"
          onClick={() => setTab("create")}
          className={`flex-1 py-2 text-xs font-medium transition-colors ${
            tab === "create"
              ? "bg-white/10 text-neutral-100"
              : "bg-black/20 text-neutral-500 hover:text-neutral-300"
          }`}
        >
          Create task
        </button>
      </div>

      {/* Content */}
      <div className="bg-[var(--ci-card)] border border-[var(--ci-border)] rounded-xl p-4 shadow-[0_0_12px_rgba(255,255,255,0.03)]">
        {tab === "status" ? (
          <AgentStatusPanel key={refreshKey} />
        ) : (
          <AgentTaskForm
            onSubmitted={() => {
              setRefreshKey((k) => k + 1);
              setTab("status");
            }}
          />
        )}
      </div>
    </div>
  );
}
