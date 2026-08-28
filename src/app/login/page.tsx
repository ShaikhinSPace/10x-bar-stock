import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { LoginForm } from "./form";

export default async function LoginPage() {
  if (await getSession()) redirect("/dashboard");
  return (
    <div className="login-wrap">
      <LoginForm />
    </div>
  );
}
