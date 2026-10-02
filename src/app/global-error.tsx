"use client";

// Last resort: the root layout itself failed, so there is no shell or stylesheet to lean on.
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
        <p>Something went wrong loading the app.</p>
        <button onClick={reset}>Try again</button>
      </body>
    </html>
  );
}
