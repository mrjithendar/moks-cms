"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  ADMIN_BAR_CLASS,
  barCookie,
  barExcludedPath,
  isAdminPath,
  type AdminBarData,
  type BarPreference,
  type CacheAction,
} from "@/lib/admin-bar";
import { authClient } from "@/lib/auth-client";
import { forgetAdminBar, signOutAndLeave } from "@/lib/sign-out";
import { ChevronDown, EyeIcon, LayoutIcon, PencilIcon, PlusIcon, SettingsIcon, SignOutIcon, UserIcon } from "../icons";
import { MenuGlyph } from "../admin/menu-icons";
import { UserAvatar } from "../UserAvatar";

const STAFF = new Set(["admin", "author", "demo"]);

/** Keep <html class="has-adminbar"> (the reserved space, globals.css) and the hint cookie in step with what is shown. */
function syncChrome(shown: boolean) {
  document.documentElement.classList.toggle(ADMIN_BAR_CLASS, shown);
}

function writePreference(value: BarPreference | null) {
  document.cookie = barCookie(value, location.protocol === "https:");
}

const BoltIcon = (p: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}>
    <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />
  </svg>
);

/**
 * The admin bar (lib/admin-bar.ts): pinned to the top of every page for staff, like WordPress's toolbar. Drawn in
 * the browser only: public HTML is cached for everyone, so it never contains the bar or anyone's name.
 */
export function AdminBar() {
  const { data: session, isPending } = authClient.useSession();
  const pathname = usePathname();
  const [framed] = useState(() => typeof window !== "undefined" && window.top !== window.self);
  const [fetched, setFetched] = useState<{ path: string; data: AdminBarData | null } | null>(null);
  const [preference, setPreference] = useState<BarPreference | null>(null);

  const role = (session?.user as { role?: string | null } | undefined)?.role ?? "";
  const staff = !!session && STAFF.has(role);
  const excluded = framed || barExcludedPath(pathname);
  const admin = isAdminPath(pathname);

  useEffect(() => {
    if (isPending || excluded) return;
    if (!staff) {
      // Signed out (or not staff): forget the hint so the next page does not reserve the bar's space.
      forgetAdminBar();
      syncChrome(false);
      return;
    }
    const ctrl = new AbortController();
    fetch(`/api/admin/bar?path=${encodeURIComponent(pathname)}`, { cache: "no-store", credentials: "same-origin", signal: ctrl.signal })
      .then(async (r) => (r.ok ? ((await r.json()) as AdminBarData) : null))
      .then((data) => setFetched({ path: pathname, data }))
      .catch(() => {
        /* aborted or offline: keep what is shown */
      });
    return () => ctrl.abort();
  }, [pathname, staff, isPending, excluded]);

  const data = staff && !excluded ? (fetched?.data ?? null) : null;
  const pref = preference ?? data?.preference ?? "on";
  const shown = !!data && (admin || pref === "on");
  const decided = !isPending && (!staff || excluded || fetched !== null);

  useEffect(() => {
    if (decided && !excluded) syncChrome(shown);
  }, [decided, shown, excluded]);

  if (!shown || !data) return null;

  function changePreference(next: BarPreference) {
    writePreference(next);
    setPreference(next);
  }

  return <Bar data={data} pathname={pathname} admin={admin} pref={pref} onPreference={changePreference} />;
}

type MenuId = "site" | "new" | "context" | "cache" | "account";

function Bar({ data, pathname, admin, pref, onPreference }: { data: AdminBarData; pathname: string; admin: boolean; pref: BarPreference; onPreference: (p: BarPreference) => void }) {
  const [open, setOpen] = useState<MenuId | null>(null);
  const [status, setStatus] = useState<{ tone: "ok" | "error" | "busy"; text: string } | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const isAdmin = data.user.role === "admin";

  // Close menus after navigating (adjust-state-on-change, no effect needed).
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setOpen(null);
  }

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!bar.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!status || status.tone === "busy") return;
    const t = setTimeout(() => setStatus(null), status.tone === "ok" ? 6000 : 12000);
    return () => clearTimeout(t);
  }, [status]);

  async function cache(action: CacheAction, confirmText?: string) {
    setOpen(null);
    if (confirmText && !window.confirm(confirmText)) return;
    setStatus({ tone: "busy", text: "Working…" });
    try {
      const r = await fetch("/api/admin/cache", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ action, ...(action === "purge-page" ? { path: pathname } : {}) }),
      });
      const body = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
      setStatus(r.ok ? { tone: "ok", text: body.message ?? "Done." } : { tone: "error", text: body.error ?? `Failed (${r.status}).` });
    } catch {
      setStatus({ tone: "error", text: "Could not reach the server. Check your connection." });
    }
  }

  const toggle = (id: MenuId) => setOpen((o) => (o === id ? null : id));
  const [primary, ...more] = data.context;

  return (
    <div
      ref={bar}
      id="admin-bar"
      data-admin-bar
      role="navigation"
      aria-label="Admin toolbar"
      className="admin-bar fixed inset-x-0 top-0 z-[45] flex h-(--adminbar-h) items-stretch bg-[#1d2327] text-[13px] leading-none text-[#f0f0f1] print:hidden"
    >
      <div className="flex min-w-0 flex-1 items-stretch">
        {/* Site / dashboard: in the admin it leads to the site, on the site to the admin (as in WordPress). */}
        <Menu
          id="site"
          open={open}
          toggle={toggle}
          label={admin ? "Visit site" : "Dashboard"}
          icon={admin ? <EyeIcon className="h-4 w-4" /> : <LayoutIcon className="h-4 w-4" />}
          href={admin ? "/" : "/admin"}
        >
          {admin ? (
            <>
              <Item href="/">Visit site</Item>
              <Item href="/" newTab>Open site in a new tab</Item>
            </>
          ) : (
            <>
              <Item href="/admin">Dashboard</Item>
              <Item href="/admin/posts">Posts</Item>
              <Item href="/admin/pages">Pages</Item>
              <Item href="/admin/media">Media</Item>
              <Item href="/admin/comments">Comments</Item>
              {isAdmin && (
                <>
                  <Sep />
                  <Item href="/admin/appearance">Appearance</Item>
                  <Item href="/admin/appearance?section=navigation">Menus</Item>
                  <Item href="/admin/settings">Settings</Item>
                  <Item href="/admin/system">System status</Item>
                </>
              )}
              <Sep />
              <Item href="/admin/user-manual">User manual</Item>
            </>
          )}
        </Menu>

        <Menu id="new" open={open} toggle={toggle} label="New" icon={<PlusIcon className="h-4 w-4" />} href="/admin/posts/new">
          <Item href="/admin/posts/new">Post</Item>
          <Item href="/admin/pages/new">Page</Item>
          <Item href="/admin/media">Media</Item>
          {isAdmin && (
            <>
              <Item href="/admin/invoices/new">Invoice</Item>
              <Item href="/admin/users">User</Item>
            </>
          )}
        </Menu>

        {primary && (
          <Menu
            id="context"
            open={open}
            toggle={toggle}
            label={primary.label}
            icon={/^(View|All)/.test(primary.label) ? <EyeIcon className="h-4 w-4" /> : <PencilIcon className="h-4 w-4" />}
            href={primary.href}
            showLabel
          >
            {more.length > 0 ? more.map((l) => <Item key={l.href} href={l.href}>{l.label}</Item>) : null}
          </Menu>
        )}

        <BarLink href="/admin/comments" label={`Comments${data.badges.comments ? `: ${data.badges.comments} waiting` : ""}`} icon={<MenuGlyph name="comments" className="h-4 w-4" />} badge={data.badges.comments} />
        {data.badges.messages > 0 && <BarLink href="/admin/messages" label={`Messages: ${data.badges.messages} new`} icon={<MenuGlyph name="inbox" className="h-4 w-4" />} badge={data.badges.messages} />}
        {data.badges.review > 0 && <BarLink href="/admin/review" label={`Review queue: ${data.badges.review} drafts`} icon={<MenuGlyph name="editorial" className="h-4 w-4" />} badge={data.badges.review} />}

        {data.cache && (
          <Menu id="cache" open={open} toggle={toggle} label="Cache" icon={<BoltIcon className="h-4 w-4" />}>
            {!data.cache.allowed && <p className="px-3 py-2 text-[#c3c4c7]">Read-only demo: these do nothing.</p>}
            {!admin && (
              <Action disabled={!data.cache.allowed} onClick={() => cache("purge-page")} hint={data.cache.cloudflare ? "This page only, on every server and at Cloudflare" : "This page only, on every server"}>
                Purge this page
              </Action>
            )}
            <Action disabled={!data.cache.allowed} onClick={() => cache("clear-pages")} hint="Every page is rendered again">
              Clear page cache
            </Action>
            <Action disabled={!data.cache.allowed} onClick={() => cache("clear-data")} hint="Content, settings, menus, integrations">
              Reload content &amp; settings
            </Action>
            <Action
              disabled={!data.cache.allowed}
              onClick={() =>
                cache(
                  "purge-all",
                  data.cache?.cloudflare
                    ? "Clear every cache on every server and purge everything at Cloudflare? Pages are fetched and rendered again on their next visit."
                    : "Clear every cache on every server? Pages are rendered again on their next visit.",
                )
              }
              hint={data.cache.cloudflare ? "Everything above, and everything at Cloudflare" : "Everything above, at once"}
            >
              Purge all caches
            </Action>
            {data.cache.cloudflare && (
              <>
                <Sep />
                <Action
                  disabled={!data.cache.allowed}
                  onClick={() => cache("cf-everything", "Purge everything at Cloudflare? Every page is fetched from the site again on its next visit.")}
                  hint="Cloudflare only"
                >
                  Cloudflare: purge everything
                </Action>
                <Item href="/admin/cache#cloudflare-purge">Cloudflare: custom purge…</Item>
              </>
            )}
            <Sep />
            <Item href="/admin/cache">Cache status &amp; tools</Item>
          </Menu>
        )}

      </div>

      {/* Result of a cache action, just under the bar (announced to screen readers). */}
      <p role="status" className={status ? `absolute inset-x-0 top-full flex items-start justify-between gap-3 bg-[#1d2327] px-3 py-2 leading-snug shadow-md ${status.tone === "error" ? "text-[#f86368]" : status.tone === "ok" ? "text-[#68de7c]" : "text-[#c3c4c7]"}` : "sr-only"}>
        {status && (
          <>
            <span>{status.text}</span>
            {status.tone !== "busy" && (
              <button type="button" className="shrink-0 text-[#c3c4c7] underline hover:text-white" onClick={() => setStatus(null)}>
                Dismiss
              </button>
            )}
          </>
        )}
      </p>

      <Menu
        id="account"
        open={open}
        toggle={toggle}
        label={`Hi, ${data.user.name}`}
        icon={<UserAvatar name={data.user.name} image={data.user.image} size="xs" className="!h-5 !w-5 !text-[9px]" />}
        align="right"
      >
        <div className="border-b border-white/10 px-3 py-2">
          <p className="truncate font-semibold">{data.user.name}</p>
          <p className="mt-1 truncate text-[#c3c4c7]">{data.user.email}</p>
        </div>
        <Item href="/admin/profile" icon={<UserIcon className="h-4 w-4" />}>Your profile</Item>
        <Item href="/account" icon={<SettingsIcon className="h-4 w-4" />}>Account settings</Item>
        <Action onClick={() => onPreference(pref === "on" ? "off" : "on")} hint={pref === "on" ? "It stays in the admin" : "Currently shown only in the admin"}>
          {pref === "on" ? "Hide toolbar on the site" : "Show toolbar on the site"}
        </Action>
        <Sep />
        <Action onClick={() => void signOutAndLeave()} icon={<SignOutIcon className="h-4 w-4" />}>Sign out</Action>
      </Menu>
    </div>
  );
}

const itemBase = "flex h-full items-center gap-1.5 px-2 sm:px-2.5 hover:bg-[#2c3338] hover:text-[#72aee6] focus-visible:bg-[#2c3338] focus-visible:text-[#72aee6] focus-visible:outline-none";

function Menu({
  id,
  open,
  toggle,
  label,
  icon,
  href,
  showLabel = false,
  align = "left",
  children,
}: {
  id: MenuId;
  open: MenuId | null;
  toggle: (id: MenuId) => void;
  label: string;
  icon: ReactNode;
  href?: string;
  showLabel?: boolean;
  align?: "left" | "right";
  children?: ReactNode;
}) {
  const panelId = useId();
  const isOpen = open === id && !!children;
  // Phones show icons only (the name stays as aria-label and tooltip); the page's own link gets its words from 640 px.
  const text = <span className={showLabel ? "hidden max-w-[16rem] truncate sm:inline" : "hidden md:inline"}>{label}</span>;
  return (
    <div className={`relative flex ${isOpen ? "bg-[#2c3338]" : ""}`}>
      {href ? (
        <Link href={href} prefetch={false} className={itemBase} aria-label={label} title={label}>
          {icon}
          {text}
        </Link>
      ) : (
        <button type="button" className={itemBase} aria-expanded={isOpen} aria-controls={panelId} onClick={() => toggle(id)} aria-label={label}>
          {icon}
          {text}
          <ChevronDown className="h-3 w-3 opacity-70" />
        </button>
      )}
      {href && children && (
        <button type="button" className={`${itemBase} !px-1`} aria-expanded={isOpen} aria-controls={panelId} aria-label={`${label}: more`} onClick={() => toggle(id)}>
          <ChevronDown className="h-3 w-3 opacity-70" />
        </button>
      )}
      {isOpen && (
        <div id={panelId} className={`absolute top-full min-w-56 max-w-[calc(100vw-1rem)] bg-[#2c3338] py-1.5 shadow-lg ${align === "right" ? "right-0" : "left-0"}`}>
          {children}
        </div>
      )}
    </div>
  );
}

const rowBase = "flex w-full items-center gap-2 px-3 py-2 text-left leading-snug text-[#f0f0f1] hover:bg-[#1d2327] hover:text-[#72aee6] focus-visible:bg-[#1d2327] focus-visible:text-[#72aee6] focus-visible:outline-none";

function Item({ href, children, icon, newTab = false }: { href: string; children: ReactNode; icon?: ReactNode; newTab?: boolean }) {
  return (
    <Link href={href} prefetch={false} className={rowBase} {...(newTab ? { target: "_blank", rel: "noopener" } : {})}>
      {icon}
      <span>{children}</span>
    </Link>
  );
}

function Action({ onClick, children, hint, icon, disabled = false }: { onClick: () => void; children: ReactNode; hint?: string; icon?: ReactNode; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`${rowBase} disabled:cursor-not-allowed disabled:opacity-50`}>
      {icon}
      <span>
        {children}
        {hint && <span className="mt-0.5 block text-[12px] text-[#a7aaad]">{hint}</span>}
      </span>
    </button>
  );
}

function Sep() {
  return <div role="separator" className="my-1.5 border-t border-white/10" />;
}

function BarLink({ href, label, icon, badge }: { href: string; label: string; icon: ReactNode; badge: number }) {
  return (
    <Link href={href} prefetch={false} className={itemBase} aria-label={label} title={label}>
      {icon}
      {badge > 0 && <span className="rounded-full bg-[#d63638] px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-white">{badge > 99 ? "99+" : badge}</span>}
    </Link>
  );
}
