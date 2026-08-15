"use client";

import { useActionState } from "react";
import { login } from "../actions";

export function LoginForm() {
  const [error, action, pending] = useActionState(login, null);

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
      <input
        id="password" name="password" type="password"
        autoComplete="current-password" required
      />

      <button type="submit" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
