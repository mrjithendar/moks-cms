import type { SVGProps } from "react";
import type { MenuIconName } from "@/lib/admin-menu";

/**
 * One icon per top-level group of the admin menu (lib/admin-menu.ts). Drawn like components/icons.tsx: a 24 px grid,
 * 1.75 px round strokes in the current text colour, hidden from screen readers (the label next to them is the name).
 * Kept as path data so the menu can pick one by name.
 */
const PATHS: Record<MenuIconName, string[]> = {
  dashboard: ["M3 11.5 12 4l9 7.5", "M5.5 9.5V20h4.5v-6h4v6h4.5V9.5"],
  posts: ["M6 3h8.5L19 7.5V21H6z", "M14 3v5h5", "M9 12.5h7M9 16.5h7"],
  editorial: ["M4 6h16v14H4z", "M4 10h16", "M8 3.5v4M16 3.5v4", "M8 14h3M8 17h6"],
  media: ["M4 5h16v14H4z", "M4 16l4.5-4.5 3.5 3.5 3-3 5 5", "M8.5 8.5a1.25 1.25 0 1 0 .01 0"],
  pages: ["M8.5 3H16l4 4v11H8.5z", "M16 3v4h4", "M4.5 7.5V21H15"],
  comments: ["M4 5h16v11H10l-5 4v-4H4z"],
  inbox: ["M3.5 13 6.5 5h11l3 8v6h-17z", "M3.5 13H9l1 2.5h4l1-2.5h5.5"],
  billing: ["M6 3h12v18l-3-2-3 2-3-2-3 2z", "M9 8h6M9 12h6M9 16h3"],
  ai: ["M7 7h10v10H7z", "M10 10h4v4h-4z", "M9.5 3.5V7M14.5 3.5V7M9.5 17v3.5M14.5 17v3.5M3.5 9.5H7M3.5 14.5H7M17 9.5h3.5M17 14.5h3.5"],
  insights: ["M4 4v16h16", "M8 16v-4M12 16V8M16 16v-6"],
  practice: ["M8.5 8 4.5 12l4 4", "M15.5 8l4 4-4 4", "M13.5 5l-3 14"],
  appearance: ["M12 3.5a8.5 8.5 0 1 0 0 17c1.4 0 2-.8 2-1.8 0-.9-.6-1.4-.6-2.3 0-1 .8-1.7 1.8-1.7h1.6a3.7 3.7 0 0 0 3.7-3.7c0-4.2-3.8-7.5-8.5-7.5z", "M7.5 12.5h.01M9 8.5h.01M13 7h.01M16.5 9.5h.01"],
  users: ["M3.5 20v-1a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v1", "M9.5 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z", "M17 15.2a4 4 0 0 1 3.5 3.8v1", "M15.5 4.7a3.5 3.5 0 0 1 0 6.6"],
  tools: ["M14.7 6.3a4 4 0 0 0-5.2 5.2L4 17v3h3l5.5-5.5a4 4 0 0 0 5.2-5.2l-2.5 2.5-2.3-.7-.7-2.3z"],
  settings: ["M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12", "M16 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4z", "M10 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z", "M18 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"],
  help: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M9.6 9.3a2.5 2.5 0 1 1 3.6 2.3c-.7.4-1.2.9-1.2 1.7v.4", "M12 17h.01"],
  pin: ["M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.3-4.1 5.9-.9z"],
  more: ["M5 12h.01M12 12h.01M19 12h.01"],
};

export function MenuGlyph({ name, filled = false, ...props }: SVGProps<SVGSVGElement> & { name: MenuIconName; filled?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

export const MENU_ICON_NAMES = Object.keys(PATHS) as MenuIconName[];
