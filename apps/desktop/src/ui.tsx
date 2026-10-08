import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { errorText, type ChangeKind } from "./api";
import { LABEL_PRESETS, splitPath } from "./util";

// ---- icons ------------------------------------------------------------------

const paths = {
  play: "M7 4.5v15l12-7.5z",
  pause: "M7 4h4v16H7zM13 4h4v16h-4z",
  plus: "M12 5v14M5 12h14",
  branch: "M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9",
  merge: "M6 3v18M6 9a9 9 0 0 0 9 9M18 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  tag: "M3 12V3h9l9 9-9 9zM7.5 7.5h.01",
  restore: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  trash: "M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3",
  folder: "M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z",
  check: "M5 12.5l4.5 4.5L19 7.5",
  close: "M6 6l12 12M18 6L6 18",
  chevron: "M6 9l6 6 6-6",
  undo: "M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
  wave: "M3 12h2M7 8v8M11 5v14M15 9v6M19 7v10M21 12h0",
  edit: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
  comment: "M4 5h16v11H9l-5 4z",
  cloud: "M7 18a4.5 4.5 0 0 1-.5-9 6 6 0 0 1 11.6 1.6A3.8 3.8 0 0 1 17.5 18z",
  sync: "M20 11a8 8 0 0 0-14.7-3.5M4 4v4h4M4 13a8 8 0 0 0 14.7 3.5M20 20v-4h-4",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  image: "M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15.5 9.5h.01",
  doc: "M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6",
  label: "M3 12V5a2 2 0 0 1 2-2h7l9 9-9 9zM8 8h.01",
  archive: "M3 5h18v4H3zM5 9v10h14V9M10 13h4",
  broom: "M14 4l-4 8M6 13h8l2 7H4zM8 16v4M12 16v4",
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const filled = name === "play" || name === "pause";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={paths[name]} />
    </svg>
  );
}

// ---- small pieces -----------------------------------------------------------

const KIND = {
  added: { sign: "+", title: "Новый" },
  modified: { sign: "~", title: "Изменён" },
  deleted: { sign: "−", title: "Удалён" },
} as const;

/** Presets first, in their order of work, then the rest by name. */
export function sortLabels(labels: string[]): string[] {
  const rank = (l: string) => {
    const i = LABEL_PRESETS.indexOf(l);
    return i < 0 ? LABEL_PRESETS.length : i;
  };
  return [...labels].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** A file content's labels ("демо", "мастер", …) as small chips. */
export function FileLabels({ labels }: { labels: string[] }) {
  if (labels.length === 0) return null;
  return (
    <span className="file-labels">
      {sortLabels(labels).map((l) => {
        const preset = LABEL_PRESETS.indexOf(l);
        return (
          <span key={l} className={`file-label ${preset >= 0 ? `file-label-${preset}` : ""}`}>
            {l}
          </span>
        );
      })}
    </span>
  );
}

export function KindBadge({ kind }: { kind: ChangeKind }) {
  return (
    <span className={`kind kind-${kind}`} title={KIND[kind].title}>
      {KIND[kind].sign}
    </span>
  );
}

export function PathLabel({ path }: { path: string }) {
  const { dir, name } = splitPath(path);
  return (
    <span className="path" title={path}>
      {dir && <span className="path-dir">{dir}</span>}
      <span className="path-name">{name}</span>
    </span>
  );
}

export function Empty({ icon, title, children }: { icon: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon name={icon} size={28} />
      </div>
      <div className="empty-title">{title}</div>
      {children && <div className="empty-text">{children}</div>}
    </div>
  );
}

// ---- modal ------------------------------------------------------------------

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
  className,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** Extra class for the dialog, e.g. a size. */
  className?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "modal-wide" : ""} ${className ?? ""}`} role="dialog" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** Asks for a name; `onSubmit` errors are shown inline and keep it open. */
export function PromptDialog({
  title,
  label,
  placeholder,
  initial = "",
  confirm,
  hint,
  password,
  onSubmit,
  onClose,
}: {
  title: string;
  label: string;
  placeholder?: string;
  initial?: string;
  confirm: string;
  hint?: ReactNode;
  password?: boolean;
  onSubmit: (value: string) => Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!value.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(value.trim());
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Отмена
          </button>
          <button className="btn btn-primary" disabled={!value.trim() || busy} onClick={submit}>
            {confirm}
          </button>
        </>
      }
    >
      <label className="field">
        <span>{label}</span>
        <input
          autoFocus
          type={password ? "password" : "text"}
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      </label>
      {hint && <div className="hint">{hint}</div>}
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}

// ---- toasts -----------------------------------------------------------------

type ToastKind = "ok" | "error" | "info";
interface ToastItem {
  id: number;
  text: string;
  kind: ToastKind;
}

const ToastContext = createContext<(text: string, kind?: ToastKind) => void>(() => {});

export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(0);
  const dismiss = useCallback((id: number) => setItems((all) => all.filter((t) => t.id !== id)), []);
  const show = useCallback(
    (text: string, kind: ToastKind = "info") => {
      const id = next.current++;
      setItems((all) => [...all.slice(-3), { id, text, kind }]);
      setTimeout(() => dismiss(id), kind === "error" ? 7000 : 3500);
    },
    [dismiss],
  );
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => dismiss(t.id)}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
