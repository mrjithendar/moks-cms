import type { ReactNode } from "react";
import { LogoMark } from "@/components/Logo";

/** The centred card the sign-in, forgot-password and reset-password pages share. */
export function AuthCard({ title, intro, children, footer }: { title: string; intro: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-[calc(100dvh-var(--spacing-header)-12rem)] items-center justify-center px-4 py-12 sm:py-16">
      <div className="w-full max-w-[26rem]">
        <div className="text-center">
          <LogoMark className="mx-auto h-10 w-10" />
          <h1 className="mt-5 text-2xl font-semibold tracking-tight text-fg">{title}</h1>
          <p className="mt-2 text-[0.9375rem] leading-6 text-fg-muted">{intro}</p>
        </div>
        <div className="mt-8 space-y-6 rounded-xl border border-line bg-surface p-5 shadow-sm sm:p-8">{children}</div>
        {footer && <p className="mt-6 text-center text-sm leading-6 text-fg-subtle">{footer}</p>}
      </div>
    </div>
  );
}
