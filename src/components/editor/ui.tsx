"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

export function IconButton({
  label,
  onClick,
  disabled,
  active,
  children,
  testId,
  className = "",
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  children: ReactNode;
  testId?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className={`grid h-8 min-w-8 place-items-center rounded-md px-1.5 text-fg transition-colors hover:bg-panel-2 disabled:pointer-events-none disabled:opacity-35 ${
        active ? "bg-accent-soft text-accent ring-1 ring-accent/40" : ""
      } ${className}`}
    >
      {children}
    </button>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
  testId,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  testId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>("input, textarea, select, button:not([data-close])");
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
      if (e.key === "Tab" && el) {
        const f = Array.from(el.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href], [tabindex]:not([tabindex='-1'])")).filter((x) => !x.hasAttribute("disabled"));
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) {
          e.preventDefault();
          f[f.length - 1].focus();
        } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) {
          e.preventDefault();
          f[0].focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-2 sm:p-4" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testId}
        className={`flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-xl border border-line bg-panel text-fg shadow-2xl ${wide ? "max-w-4xl" : "max-w-md"}`}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <button data-close type="button" aria-label="Close" className="rounded p-1 hover:bg-panel-2" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3 text-sm">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = "default",
  disabled,
  type = "button",
  testId,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "danger";
  disabled?: boolean;
  type?: "button" | "submit";
  testId?: string;
}) {
  const cls =
    variant === "primary"
      ? "bg-accent text-white hover:brightness-110"
      : variant === "danger"
        ? "bg-danger text-white hover:brightness-110"
        : "border border-line bg-panel hover:bg-panel-2";
  return (
    <button type={type} onClick={onClick} disabled={disabled} data-testid={testId} className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-40 ${cls}`}>
      {children}
    </button>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-muted">{hint}</span>}
    </label>
  );
}

export const inputCls = "w-full rounded-md border border-line bg-panel px-2 py-1 text-sm";
