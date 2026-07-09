"use client";

import { useState, useCallback } from "react";
import { AgentTaskForm } from "@/components/agents/AgentTaskForm";
import { AgentStatusPanel } from "@/components/agents/AgentStatusPanel";

export default function AgentsPage() {
  const [refreshSignal, setRefreshSignal] = useState(0);

  const handleSubmitted = useCallback(() => {
    setRefreshSignal((n) => n + 1);
  }, []);

  return (
    <div className="min-h-screen px-4 py-6 pb-28 max-w-xl mx-auto space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-lg font-semibold text-neutral-100">Agent command center</h1>
        <p className="text-xs text-neutral-500 mt-0.5">
          Submit tasks and monitor agent queue / execution state.
        </p>
      </div>

      {/* Status panel — always visible */}
      <section className="bg-[var(--ci-card)] border border-[var(--ci-border)] rounded-xl p-4 shadow-[0_0_12px_rgba(255,255,255,0.03)]">
        <AgentStatusPanel refreshSignal={refreshSignal} />
      </section>

      {/* Task creation form */}
      <section className="bg-[var(--ci-card)] border border-[var(--ci-border)] rounded-xl p-4 shadow-[0_0_12px_rgba(255,255,255,0.03)]">
        <h2 className="text-sm font-semibold text-neutral-100 mb-3">Create task</h2>
        <AgentTaskForm onSubmitted={handleSubmitted} />
      </section>
    </div>
  );
}
