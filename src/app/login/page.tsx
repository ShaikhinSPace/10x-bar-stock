import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { homeFor } from "../(app)/guard";
import { LoginForm } from "./form";

export default async function LoginPage() {
  const user = await getSession();
  if (user) redirect(homeFor(user));
  return (
    <div className="login-wrap">
      <LoginForm />
    </div>
  );
}
