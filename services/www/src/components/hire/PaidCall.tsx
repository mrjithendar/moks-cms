"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { confirmCallPaymentAction, createCallOrderAction, paidCallQuoteAction } from "@/app/_actions/payments";
import { Container } from "@/components/Container";
import { Turnstile } from "@/components/Turnstile";
import { Alert, Button, Field, Input, Select, Textarea } from "@/components/ui/form";
import { authClient } from "@/lib/auth-client";
import { moneyLabel, type PayCurrency } from "@/lib/hire-me";
import { trackLead } from "./track";

type Quote = { currency: PayCurrency; perMinute: number; durations: number[]; keyId: string };
type RazorpayResponse = { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string };
type RazorpayInstance = { open: () => void; on: (event: string, cb: (r: { error?: { description?: string } }) => void) => void };
type RazorpayCtor = new (options: Record<string, unknown>) => RazorpayInstance;

const CHECKOUT_JS = "https://checkout.razorpay.com/v1/checkout.js";
let checkoutLoad: Promise<RazorpayCtor> | null = null;

/** Razorpay's Checkout script, loaded on the first "Pay" only (nothing third-party for visitors who never pay). */
function loadCheckout(): Promise<RazorpayCtor> {
  const w = globalThis as typeof globalThis & { Razorpay?: RazorpayCtor };
  if (w.Razorpay) return Promise.resolve(w.Razorpay);
  checkoutLoad ??= new Promise<RazorpayCtor>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = CHECKOUT_JS;
    s.async = true;
    s.onload = () => (w.Razorpay ? resolve(w.Razorpay) : reject(new Error("Razorpay unavailable")));
    s.onerror = () => reject(new Error("Razorpay blocked"));
    document.head.appendChild(s);
  });
  checkoutLoad.catch(() => (checkoutLoad = null));
  return checkoutLoad;
}

/**
 * "Book a paid call" on /hire-me: choose a length, pay with Razorpay, then pick a time. The page is cached, so the
 * price (INR in India, USD elsewhere) is fetched from the server on load; the server sets the amount again when the
 * order is created, so nothing the browser sends can change what is charged.
 */
export function PaidCall({ title, summary, siteKey, merchant }: { title: string; summary: string; siteKey: string | undefined; merchant: string }) {
  const { data: session } = authClient.useSession();
  const signedIn = Boolean(session?.user);
  const [quote, setQuote] = useState<Quote | null | "off">(null);
  const [minutes, setMinutes] = useState<number>(0);
  const [token, setToken] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [error, setError] = useState<{ text: string; issues?: string[] } | null>(null);
  const [done, setDone] = useState<{ bookingUrl: string; minutes: number } | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    let live = true;
    void paidCallQuoteAction().then((r) => {
      if (!live) return;
      if (r.ok && r.data.ready) {
        setQuote(r.data);
        setMinutes(r.data.durations.includes(30) ? 30 : r.data.durations[0]!);
      } else setQuote("off");
    });
    return () => {
      live = false;
    };
  }, []);

  if (quote === "off") return null;

  function pay(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!quote || quote === "off") return;
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    if (!signedIn && siteKey && !token) {
      setError({ text: "Please complete the human verification." });
      return;
    }
    setError(null);
    start(async () => {
      const r = await createCallOrderAction({ name: f.name ?? "", email: f.email ?? "", minutes, topic: f.topic ?? "" }, token);
      setToken(null);
      setResetKey((k) => k + 1);
      if (!r.ok) {
        setError({ text: r.error, issues: r.issues });
        return;
      }
      const order = r.data;
      trackLead("payment_started", "paid_call");
      let Razorpay: RazorpayCtor;
      try {
        Razorpay = await loadCheckout();
      } catch {
        setError({ text: "Razorpay's checkout could not load. Disable any blocker for checkout.razorpay.com and try again." });
        return;
      }
      await new Promise<void>((settle) => {
        const rzp = new Razorpay({
          key: order.keyId,
          order_id: order.orderId,
          amount: order.amount,
          currency: order.currency,
          name: merchant,
          description: order.description,
          prefill: { name: order.name, email: order.email },
          notes: { minutes: String(order.minutes) },
          theme: { color: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || undefined },
          modal: { ondismiss: () => settle() },
          handler: (resp: RazorpayResponse) => {
            void confirmCallPaymentAction({ orderId: resp.razorpay_order_id, paymentId: resp.razorpay_payment_id, signature: resp.razorpay_signature }).then((c) => {
              if (c.ok) {
                trackLead("payment_completed", "paid_call");
                setDone(c.data);
              } else setError({ text: c.error });
              settle();
            });
          },
        });
        rzp.on("payment.failed", (resp) => setError({ text: `Payment failed: ${resp.error?.description ?? "please try again"}. You have not been charged.` }));
        rzp.open();
      });
    });
  }

  const loading = quote === null;
  const total = !loading && minutes ? moneyLabel(quote.perMinute * minutes, quote.currency) : "";

  return (
    <section id="paid-call" aria-labelledby="paid-call-title" className="scroll-mt-24 border-b border-line py-section">
      <Container narrow>
        <h2 id="paid-call-title" className="text-heading font-semibold text-fg">{title}</h2>
        {summary && <p className="mt-2 text-fg-muted">{summary}</p>}
        <div className="mt-6 rounded-2xl border border-line bg-surface p-4 shadow-sm sm:p-8">
          {done ? (
            <div className="space-y-4">
              <Alert tone="success">Payment received, thank you. Now choose a time for your {done.minutes}-minute call. A receipt from Razorpay is on its way to your email.</Alert>
              {done.bookingUrl && (
                <a href={done.bookingUrl} target="_blank" rel="noopener" onClick={() => trackLead("booking_clicked", "paid_call")}
                  className="inline-flex items-center gap-2 rounded-xl bg-accent px-5 py-3 text-sm font-semibold text-on-accent hover:opacity-90">
                  Pick a time for your call
                </a>
              )}
            </div>
          ) : loading ? (
            <p className="text-sm text-fg-muted" aria-live="polite">Loading prices…</p>
          ) : !siteKey && !signedIn ? (
            <Alert tone="info">Paid calls need human verification (Cloudflare Turnstile), which is not configured yet.</Alert>
          ) : (
            <form onSubmit={pay} className="grid grid-cols-[minmax(0,1fr)] gap-5 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <p className="text-sm text-fg-muted">
                  <strong className="text-fg">{moneyLabel(quote.perMinute, quote.currency)} per minute</strong>
                  {quote.currency === "INR" ? " (paying from India, in rupees)" : " (in US dollars)"}
                </p>
              </div>
              <Field label="Call length" htmlFor="pc-minutes">
                <Select id="pc-minutes" name="minutes" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} required>
                  {quote.durations.map((m) => (
                    <option key={m} value={m}>{m} minutes · {moneyLabel(quote.perMinute * m, quote.currency)}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Name" htmlFor="pc-name"><Input id="pc-name" name="name" autoComplete="name" required minLength={2} maxLength={100} /></Field>
              <div className="sm:col-span-2">
                <Field label="Email (for the receipt and the invite)" htmlFor="pc-email"><Input id="pc-email" name="email" type="email" autoComplete="email" required maxLength={200} /></Field>
              </div>
              <div className="sm:col-span-2">
                <Field label="What would you like to discuss? (optional)" htmlFor="pc-topic">
                  <Textarea id="pc-topic" name="topic" rows={3} maxLength={1000} placeholder="So I can prepare: your setup and the question you want answered." />
                </Field>
              </div>
              <div className="space-y-4 sm:col-span-2">
                {!signedIn && siteKey && <Turnstile siteKey={siteKey} onToken={setToken} resetKey={resetKey} />}
                {error && (
                  <Alert tone="error">
                    {error.text}
                    {error.issues && <ul className="mt-1 list-disc pl-5">{error.issues.map((i) => <li key={i}>{i}</li>)}</ul>}
                  </Alert>
                )}
                <Button type="submit" disabled={pending}>{pending ? "Opening checkout…" : `Pay ${total}`}</Button>
                <p className="text-xs text-fg-subtle">
                  Payments are processed by Razorpay; card and UPI details never reach this site. After paying you choose a time for the call. See the{" "}
                  <Link href="/privacy-policy" className="underline">privacy policy</Link> and <Link href="/terms" className="underline">terms</Link>.
                </p>
              </div>
            </form>
          )}
        </div>
      </Container>
    </section>
  );
}
