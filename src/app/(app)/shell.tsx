"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState, useTransition } from "react";
import { cap, type SessionUser } from "@/lib/model";
import { logout, undoMove, type Result } from "../actions";

export type Tab = "dashboard" | "stock" | "delivery" | "activity" | "manage";

/* ============================ icons ============================ */

const NAV_ICON: Record<Tab, React.ReactNode> = {
  dashboard: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="8" height="9" rx="1.5" />
      <rect x="13" y="3" width="8" height="5" rx="1.5" />
      <rect x="13" y="11" width="8" height="10" rx="1.5" />
      <rect x="3" y="15" width="8" height="6" rx="1.5" />
    </svg>
  ),
  stock: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
    </svg>
  ),
  delivery: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 8.5 12 4l9 4.5v7L12 20l-9-4.5z" strokeLinejoin="round" />
      <path d="M3 8.5 12 13l9-4.5M12 13v7" strokeLinejoin="round" />
    </svg>
  ),
  activity: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 8v4l3 2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  manage: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
      <path
        d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 2h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12a7 7 0 0 0 .1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 22h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6A7 7 0 0 0 19 12z"
        strokeLinejoin="round"
      />
    </svg>
  ),
};

/* ======================= shared action context =======================

   Every tab runs server actions the same way: fire it inside a transition,
   toast what happened, and only then let the caller react to success. That
   state has to outlive a route change, so it lives here in the shell rather
   than in any one page.                                                    */

type Ctx = {
  /** True while any action is in flight — the whole app shares one transition. */
  pending: boolean;
  /** Runs an action, toasts the outcome, and calls onOk only if it succeeded. */
  run: (fn: () => Promise<Result>, okMsg: string, onOk?: () => void) => void;
  /** Shows a message without running anything. */
  say: (msg: string, error?: boolean) => void;
};

const ActionCtx = createContext<Ctx | null>(null);

export function useAction(): Ctx {
  const ctx = useContext(ActionCtx);
  if (!ctx) throw new Error("useAction must be called inside the app shell");
  return ctx;
}

/* ============================ shell ============================ */

export function Shell({ user, children }: { user: SessionUser; children: React.ReactNode }) {
  const [toast, setToast] = useState<{ msg: string; error?: boolean; moveId?: number } | null>(null);
  const [pending, startTransition] = useTransition();
  const pathname = usePathname();

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!toast) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), toast.moveId ? 6000 : 3000);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [toast]);

  function run(fn: () => Promise<Result>, okMsg: string, onOk?: () => void) {
    startTransition(async () => {
      const r = await fn();
      if (r.ok) {
        onOk?.();
        setToast({ msg: okMsg, moveId: r.moveId });
      } else {
        setToast({ msg: r.error, error: true });
      }
    });
  }

  const say = (msg: string, error?: boolean) => setToast({ msg, error });

  const tabs: Tab[] = user.role === "owner"
    ? ["dashboard", "stock", "delivery", "activity", "manage"]
    : ["dashboard", "stock", "delivery", "activity"];

  // Link handles the URL, the back button and scroll-to-top; the shell only
  // has to say which one is current.
  const nav = (
    <>
      {tabs.map((t) => (
        <Link key={t} href={`/${t}`} className={pathname === `/${t}` ? "on" : ""}
          aria-current={pathname === `/${t}` ? "page" : undefined}>
          {NAV_ICON[t]}
          {cap(t)}
        </Link>
      ))}
    </>
  );

  const brand = (
    <div className="brand">
      <span className="mark">10<b>X</b> Bar</span>
      <span className="sub">Stock control</span>
    </div>
  );

  return (
    <ActionCtx.Provider value={{ pending, run, say }}>
      <h2 className="sr-only">10X Bar stock control</h2>

      <div className="app">
        <aside className="sidebar">
          {brand}
          <div className="snav">{nav}</div>
          <div className="foot">Store counts whole bottles · bars count partials</div>
        </aside>

        <div className="content">
          <div className="topbar">{brand}</div>
          <main className="wrap">
            <div className="whoami">
              <span className="nm">Signed in as {user.name}</span>
              <span className="role">{user.role}</span>
              <button onClick={() => logout()}>Sign out</button>
            </div>

            {children}
          </main>
        </div>
      </div>

      <nav className="mnav"><div className="mnav-in">{nav}</div></nav>

      {toast && (
        <div className="toast show" role="status" aria-live={toast.error ? "assertive" : "polite"}
          style={toast.error ? { borderColor: "var(--red)" } : undefined}>
          <span className="tx">{toast.msg}</span>
          {toast.moveId !== undefined && (
            <button className="undo" onClick={() => {
              const id = toast.moveId!;
              setToast(null);
              run(() => undoMove(id), "Entry undone");
            }}>
              Undo
            </button>
          )}
        </div>
      )}
    </ActionCtx.Provider>
  );
}
