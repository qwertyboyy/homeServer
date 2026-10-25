import { BellRing, Bot, CalendarClock, MessageSquare, ShieldCheck, type LucideIcon } from "lucide-react";
import type { Metadata } from "next";
import { Card, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "AI & Automation" };

const PLANNED: { icon: LucideIcon; title: string; body: string }[] = [
  { icon: Bot, title: "Asisten AI", body: "Integrasi DeepSeek atau provider lain lewat backend. API key tidak pernah dikirim ke browser." },
  { icon: CalendarClock, title: "Jadwal automation", body: "Jadwal, hasil run, status, dan riwayat eksekusi." },
  { icon: BellRing, title: "Notifikasi", body: "Disk hampir penuh, service kritis mati, suhu dan RAM/swap melewati ambang." },
  { icon: MessageSquare, title: "Channel", body: "Telegram, email, atau WhatsApp setelah metode integrasi dan biayanya dievaluasi." },
];

export default function AiPage() {
  return (
    <>
      <PageHeader title="AI & Automation" description="Tahap berikutnya — belum aktif di MVP." />
      <Card className="mb-4">
        <p className="flex items-start gap-2 text-sm text-ink-2">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden />
          AI tidak akan pernah mengeksekusi perintah server tanpa allowlist, persetujuan administrator, dan audit log.
        </p>
      </Card>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {PLANNED.map(({ icon: Icon, title, body }, i) => (
          <Card key={title} delay={i * 100} className="opacity-80">
            <div className="flex items-start gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-surface-2">
                <Icon className="size-5 text-muted" aria-hidden />
              </span>
              <div>
                <h2 className="flex items-center gap-2 font-medium">
                  {title}
                  <span className="rounded-full border border-line px-1.5 py-px text-[10px] font-medium uppercase tracking-wider text-muted">
                    Segera
                  </span>
                </h2>
                <p className="mt-1 text-sm text-muted">{body}</p>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
