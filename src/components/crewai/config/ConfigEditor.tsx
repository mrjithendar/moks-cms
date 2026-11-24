"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

/**
 * The configuration file editor: CodeMirror 6 (as the practice editor) with highlighting for YAML (crews, flows,
 * schedules…), Markdown with YAML front matter (agents, tasks, SKILL.md) and JSON (manifest, schemas). The highlighters
 * are small stream tokenizers (no extra packages): keys, strings, numbers, booleans, comments, list markers, headings,
 * {placeholders} and the front matter fence, coloured by basicSetup's default highlight style. Ctrl/Cmd+S saves.
 */

type Mode = "yaml" | "markdown" | "json";
export const modeOf = (path: string): Mode => (path.endsWith(".md") ? "markdown" : path.endsWith(".json") ? "json" : "yaml");

function subscribeTheme(onChange: () => void) {
  const obs = new MutationObserver(onChange);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", onChange);
  return () => {
    obs.disconnect();
    mq.removeEventListener("change", onChange);
  };
}
const siteIsDark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
};

type Stream = { sol(): boolean; eol(): boolean; match(re: RegExp | string, consume?: boolean): unknown; next(): string | undefined; skipToEnd(): void; peek(): string | undefined; eatSpace(): boolean; string: string; pos: number };

function yamlToken(stream: Stream): string | null {
  if (stream.eatSpace()) return null;
  if (stream.match(/^#.*/)) return "comment";
  if (stream.sol() && stream.match(/^---\s*$/)) return "meta";
  if (stream.match(/^- /)) return "punctuation";
  if (stream.match(/^[A-Za-z_][\w.-]*(?=\s*:(\s|$))/)) return "propertyName";
  if (stream.match(/^"(?:[^"\\]|\\.)*"?/) || stream.match(/^'(?:[^']|'')*'?/)) return "string";
  if (stream.match(/^(true|false|null|~)(?=\s|,|\]|\}|$)/)) return "atom";
  if (stream.match(/^-?\d+(\.\d+)?(?=\s|,|\]|\}|$)/)) return "number";
  if (stream.match(/^\{[a-z][a-z0-9_]*\}/)) return "variableName";
  if (stream.match(/^[|>][-+]?\s*$/)) return "keyword";
  if (stream.match(/^[:,[\]{}]/)) return "punctuation";
  stream.next();
  return "string";
}

type MdState = { front: "before" | "in" | "after" };

function mdToken(stream: Stream, state: MdState): string | null {
  if (stream.sol() && stream.match(/^---\s*$/)) {
    state.front = state.front === "before" ? "in" : "after";
    return "meta";
  }
  if (state.front === "before" && stream.sol() && !stream.match(/^---/, false)) state.front = "after";
  if (state.front === "in") return yamlToken(stream);
  if (stream.sol() && stream.match(/^#{1,6} .*/)) return "heading";
  if (stream.sol() && stream.match(/^\s*([-*+]|\d+\.) /)) return "punctuation";
  if (stream.match(/^`[^`]*`/)) return "monospace";
  if (stream.match(/^\{[a-z][a-z0-9_]*\}/)) return "variableName";
  if (stream.match(/^\*\*[^*]+\*\*/)) return "strong";
  if (stream.match(/^<\/?[A-Za-z][^>]*>/)) return "meta";
  stream.next();
  return null;
}

function jsonToken(stream: Stream): string | null {
  if (stream.eatSpace()) return null;
  if (stream.match(/^"(?:[^"\\]|\\.)*"(?=\s*:)/)) return "propertyName";
  if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
  if (stream.match(/^(true|false|null)\b/)) return "atom";
  if (stream.match(/^-?\d+(\.\d+)?([eE][-+]?\d+)?/)) return "number";
  stream.next();
  return "punctuation";
}

export function ConfigEditor({ path, value, onChange, onSave, readOnly = false, label }: { path: string; value: string; onChange?: (v: string) => void; onSave?: () => void; readOnly?: boolean; label?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const cb = useRef({ onChange, onSave });
  useEffect(() => {
    cb.current = { onChange, onSave };
  });
  const dark = useSyncExternalStore(subscribeTheme, siteIsDark, () => false);
  const viewRef = useRef<import("@codemirror/view").EditorView | null>(null);
  const initial = useRef(value);

  useEffect(() => {
    let destroyed = false;
    (async () => {
      const [{ EditorView, keymap }, { EditorState }, cmds, lang, { basicSetup }] = await Promise.all([import("@codemirror/view"), import("@codemirror/state"), import("@codemirror/commands"), import("@codemirror/language"), import("codemirror")]);
      if (destroyed || !host.current) return;
      const mode = modeOf(path);
      const language =
        mode === "markdown"
          ? lang.StreamLanguage.define<MdState>({ name: "markdown-front-matter", startState: () => ({ front: "before" }), token: (s, st) => mdToken(s as unknown as Stream, st), copyState: (s) => ({ ...s }) })
          : lang.StreamLanguage.define({ name: mode, token: (s) => (mode === "json" ? jsonToken : yamlToken)(s as unknown as Stream) });
      const theme = EditorView.theme(
        {
          "&": { fontSize: "13px", height: "100%", backgroundColor: "var(--color-surface)", color: "var(--color-fg)" },
          ".cm-content": { fontFamily: "var(--font-jetbrains), ui-monospace, monospace", caretColor: "var(--color-accent)" },
          ".cm-gutters": { backgroundColor: "var(--color-surface-muted)", color: "var(--color-fg-subtle)", borderRight: "1px solid var(--color-line)" },
          ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "color-mix(in oklab, var(--color-accent) 7%, transparent)" },
          "&.cm-focused": { outline: "none" },
          ".cm-scroller": { overflow: "auto" },
        },
        { dark },
      );
      const view = new EditorView({
        parent: host.current,
        state: EditorState.create({
          doc: initial.current,
          extensions: [
            keymap.of([{ key: "Mod-s", run: () => (cb.current.onSave?.(), true), preventDefault: true }, cmds.indentWithTab]),
            basicSetup,
            // basicSetup's default highlight style colours the token names the tokenizers return.
            language,
            lang.indentUnit.of("  "),
            EditorState.tabSize.of(2),
            EditorView.lineWrapping,
            theme,
            EditorView.editable.of(!readOnly),
            EditorState.readOnly.of(readOnly),
            EditorView.contentAttributes.of({ "aria-label": label ?? `Editor for ${path}` }),
            EditorView.updateListener.of((u) => {
              if (u.docChanged) cb.current.onChange?.(u.state.doc.toString());
            }),
          ],
        }),
      });
      viewRef.current = view;
    })();
    return () => {
      destroyed = true;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
    // A new file or theme starts a new editor; the text is taken from `value` at that moment.
  }, [path, dark, readOnly, label]);

  // A value set from outside (a revert, a template) replaces the document.
  useEffect(() => {
    const v = viewRef.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    initial.current = value;
  }, [value]);

  return <div ref={host} className="h-[min(70vh,40rem)] overflow-hidden rounded-lg border border-line" />;
}
