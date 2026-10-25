import type { Metadata } from "next";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Masuk" };

export default function LoginPage() {
  return (
    <main className="grid min-h-[100dvh] place-items-center px-4 py-10">
      <LoginForm />
    </main>
  );
}
