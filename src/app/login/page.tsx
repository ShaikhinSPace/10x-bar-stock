import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getSettings } from "@/lib/db";
import { homeFor } from "../(app)/guard";
import { LoginForm } from "./form";

export default async function LoginPage() {
  const [user, settings] = await Promise.all([getSession(), getSettings()]);
  if (user) redirect(homeFor(user));
  return (
    <div className="login-wrap">
      <LoginForm barName={settings.bar_name} subtitle={settings.app_subtitle} />
    </div>
  );
}
