"use client";

import { useActionState, useState } from "react";
import { login } from "../actions";

export function LoginForm() {
  const [error, action, pending] = useActionState(login, null);
  const [show, setShow] = useState(false);

  return (
    <form className="login" action={action}>
      <h1>10X Bar</h1>
      <div className="sub">Stock control — sign in to log moves.</div>

      {error && <div className="err">{error}</div>}

      <label htmlFor="username">Username</label>
      <input
        id="username" name="username" autoComplete="username"
        autoCapitalize="none" autoCorrect="off" required
      />

      <label htmlFor="password">Password</label>
      <div className="pw">
        <input
          id="password" name="password" type={show ? "text" : "password"}
          autoComplete="current-password" autoCapitalize="none" autoCorrect="off"
          spellCheck={false} required
        />
        <button
          type="button" className="peek" onClick={() => setShow(!show)}
          aria-label={show ? "Hide password" : "Show password"} aria-pressed={show}
        >
          {show ? <EyeOff /> : <Eye />}
        </button>
      </div>

      <button type="submit" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

function Eye() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOff() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M10.6 6.2A8.6 8.6 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17 17 0 0 1-3.3 4.05M6.2 7.9A17 17 0 0 0 2 12s3.6 6.5 10 6.5a9.6 9.6 0 0 0 3.9-.8"
        strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" strokeLinecap="round" />
      <path d="M3 3l18 18" strokeLinecap="round" />
    </svg>
  );
}
