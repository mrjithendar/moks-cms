"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * Accessible popover for numbers with details (Content optimization). The repo has no Popover/HoverCard primitive,
 * so this is a small one that follows the WAI-ARIA tooltip and non-modal dialog patterns:
 *
 * - mouse hover (pointer type "mouse" only, short delay) and keyboard focus open it as a tooltip: the trigger gets
 *   `aria-describedby`, focus stays on the trigger, nothing is trapped;
 * - click / tap / Enter / Space open it as a dialog (`role="dialog"`, `aria-expanded`): focus moves inside and Tab is
 *   trapped until it is closed;
 * - Esc closes either and returns focus to the trigger; clicking outside closes the dialog form.
 * Never relies on hover alone: everything shown on hover is reachable by tap and keyboard.
 */
type Mode = "hover" | "focus" | "click";

export function Popover({ trigger, label, children, onOpen, className = "" }: { trigger: ReactNode; label: string; children: (mode: Mode) => ReactNode; onOpen?: () => void; className?: string }) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [alignRight, setAlignRight] = useState(false);
  const id = useId();
  const wrap = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const open = (m: Mode) => {
    clear();
    const r = btn.current?.getBoundingClientRect();
    setAlignRight(Boolean(r && r.left > window.innerWidth / 2));
    setMode((cur) => (cur === "click" && m !== "click" ? cur : m));
    onOpen?.();
  };
  const close = (returnFocus = false) => {
    clear();
    setMode(null);
    if (returnFocus) btn.current?.focus();
  };
  // Document listeners call the latest close() without re-subscribing on every render.
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });

  // Click-opened: move focus in, trap Tab, close on Esc / outside click.
  useEffect(() => {
    if (mode !== "click") return;
    const focusables = () => [...(panel.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])];
    (focusables()[0] ?? panel.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current(true);
      } else if (e.key === "Tab") {
        const items = focusables();
        if (!items.length) return e.preventDefault();
        const first = items[0]!;
        const last = items[items.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [mode]);

  // Hover/focus tooltips also close on Esc (WCAG 1.4.13: dismissible without moving the pointer or focus).
  useEffect(() => {
    if (mode !== "hover" && mode !== "focus") return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeRef.current();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mode]);

  useEffect(() => clear, []);

  const tooltip = mode === "hover" || mode === "focus";
  return (
    <span ref={wrap} className={`relative inline-block ${className}`} onPointerLeave={(e) => e.pointerType === "mouse" && mode === "hover" && (timer.current = setTimeout(() => close(), 180))} onPointerEnter={(e) => e.pointerType === "mouse" && mode === "hover" && clear()}>
      <button
        ref={btn}
        type="button"
        aria-label={label}
        aria-expanded={mode === "click"}
        aria-controls={mode ? id : undefined}
        aria-describedby={tooltip ? id : undefined}
        aria-haspopup="dialog"
        onPointerEnter={(e) => {
          if (e.pointerType !== "mouse" || mode === "click") return;
          clear();
          timer.current = setTimeout(() => open("hover"), 120);
        }}
        onFocus={() => mode !== "click" && open("focus")}
        onBlur={(e) => {
          if (mode === "focus" && !panel.current?.contains(e.relatedTarget as Node)) close();
        }}
        onClick={() => (mode === "click" ? close(true) : open("click"))}
        className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-md px-1.5 tabular-nums underline decoration-dotted decoration-fg-subtle underline-offset-4 hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {trigger}
      </button>
      {mode && (
        <div
          ref={panel}
          id={id}
          role={tooltip ? "tooltip" : "dialog"}
          aria-label={tooltip ? undefined : label}
          aria-modal={tooltip ? undefined : false}
          tabIndex={-1}
          className={`absolute top-full z-40 mt-1 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-line bg-surface p-3 text-left text-sm shadow-lg outline-none ${alignRight ? "right-0" : "left-0"}`}
        >
          {children(mode)}
          {tooltip && <p className="mt-2 text-[0.7rem] text-fg-subtle">Press Enter or tap for actions · Esc to close</p>}
        </div>
      )}
    </span>
  );
}
