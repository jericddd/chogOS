"use client";

import { useState } from "react";

export function shortValue(value: string): string {
  if (value.length <= 22) {
    return value;
  }
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="rounded-full border border-line px-2 py-0.5 text-[0.65rem] uppercase tracking-[0.12em] text-muted hover:text-foreground"
      aria-label={`Copy ${label}`}
      onClick={() => {
        const write = navigator.clipboard?.writeText(value);
        if (!write) {
          return;
        }
        void write.then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export function HashField({
  label,
  value,
  href,
  linkLabel,
}: {
  label: string;
  value: string | null;
  href?: string | null;
  linkLabel?: string;
}) {
  const full = value && value.trim().length > 0 ? value : null;
  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-[0.14em] text-muted">{label}</dt>
      {full ? (
        <dd className="mt-0.5 flex min-w-0 flex-wrap items-center gap-2">
          <code className="break-all font-mono text-xs" title={full}>
            {shortValue(full)}
          </code>
          <span className="sr-only" data-full-value={full}>
            {full}
          </span>
          <CopyButton value={full} label={label} />
          {href ? (
            <a className="text-xs text-accent hover:underline" href={href} target="_blank" rel="noopener noreferrer">
              {linkLabel ?? "Open"}
            </a>
          ) : null}
          {full.length > 22 ? (
            <details className="w-full">
              <summary className="cursor-pointer text-xs text-muted">Full value</summary>
              <code className="mt-1 block break-all font-mono text-xs">{full}</code>
            </details>
          ) : null}
        </dd>
      ) : (
        <dd className="mt-0.5 text-sm text-muted">—</dd>
      )}
    </div>
  );
}

export function ExternalAnchor({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a className="text-accent hover:underline" href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}
