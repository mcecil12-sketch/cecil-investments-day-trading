"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Lock } from "lucide-react";

export function LockButton() {
  const pathname = usePathname();
  const [loading, setLoading] = useState(false);

  if (pathname === "/signin") return null;

  async function handleLock() {
    setLoading(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.href = "/signin";
    }
  }

  return (
    <div className="app-topbar">
      <button type="button" className="lock-btn" onClick={handleLock} disabled={loading} aria-label="Lock">
        <Lock size={13} />
        Lock
      </button>
    </div>
  );
}
