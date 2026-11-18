"use client";

export function PrintButton() {
  return <button type="button" onClick={() => window.print()} className="min-h-9 rounded-md border border-line-strong px-3 text-sm print:hidden">Print / Save as PDF</button>;
}
