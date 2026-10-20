import { connection } from "next/server";
import { Suspense } from "react";
import { ShellFrame } from "@/components/shell/shell-frame";
import { aiStatusLabel, readAppConfig } from "@/lib/config/env";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <ShellFrame
      status={
        <Suspense fallback={<p className="text-right text-[0.65rem] leading-4 text-muted">Always running</p>}>
          <HeaderStatus />
        </Suspense>
      }
    >
      {children}
    </ShellFrame>
  );
}

async function HeaderStatus() {
  await connection();
  let status: string | null = null;
  try {
    const label = aiStatusLabel(readAppConfig());
    if (!label.startsWith("Awaiting")) {
      status = label;
    }
  } catch {
    status = null;
  }
  return (
    <p className="max-w-[10rem] text-right text-[0.65rem] leading-4 text-muted">
      Always running
      {status ? (
        <>
          <br />
          {status}
        </>
      ) : null}
    </p>
  );
}
