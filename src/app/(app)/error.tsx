"use client";

// Catches a failed page load (database unreachable, cold-start timeout) inside the app
// shell, so the nav stays and the user can retry instead of landing on a bare error page.
export default function AppError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="empty">
      Couldn&apos;t load this page.
      <div style={{ marginTop: 12 }}>
        <button className="btn" onClick={reset}>Try again</button>
      </div>
    </div>
  );
}
