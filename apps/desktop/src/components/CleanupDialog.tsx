import { useEffect, useState } from "react";
import { api, errorText, type Cleanup, type Stats } from "../api";
import { Icon, Modal, useToast } from "../ui";
import { formatSize, plural } from "../util";

const PERIODS: { days: number | null; label: string }[] = [
  { days: null, label: "Не трогать" },
  { days: 30, label: "Старше месяца" },
  { days: 90, label: "Старше 3 месяцев" },
  { days: 180, label: "Старше полугода" },
  { days: 365, label: "Старше года" },
];

/** Frees disk space: deleted branches always, old takes on request. */
export function CleanupDialog({
  root,
  stats,
  onClose,
  onDone,
}: {
  root: string;
  stats: Stats | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [days, setDays] = useState<number | null>(null);
  const [plan, setPlan] = useState<Cleanup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setPlan(null);
    setError(null);
    api
      .cleanup(root, days, true)
      .then((p) => alive && setPlan(p))
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [root, days]);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const done = await api.cleanup(root, days, false);
      toast(done.bytes > 0 ? `Освобождено ${formatSize(done.bytes)}` : "Освобождать нечего", "ok");
      onDone();
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Место на диске"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Отмена
          </button>
          <button className="btn btn-primary" disabled={!plan || plan.bytes === 0 || busy} onClick={run}>
            <Icon name="broom" />{" "}
            {busy ? "Очищаю…" : plan && plan.bytes > 0 ? `Освободить ${formatSize(plan.bytes)}` : "Освободить"}
          </button>
        </>
      }
    >
      {stats && (
        <div className="stat-line">
          История занимает <b>{formatSize(stats.storedBytes)}</b>
          {stats.contentBytes > stats.storedBytes && (
            <span className="muted"> · без повторов и сжатия было бы {formatSize(stats.contentBytes)}</span>
          )}
        </div>
      )}

      <label className="field">
        <span>Файлы промежуточных версий</span>
        <select value={days ?? ""} onChange={(e) => setDays(e.target.value ? Number(e.target.value) : null)}>
          {PERIODS.map((p) => (
            <option key={p.label} value={p.days ?? ""}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <div className="hint">
        {days === null
          ? "Удалятся только версии, к которым больше не ведёт ни одна ветка, метка или комментарий, например из удалённых веток."
          : "Версии останутся в истории, но их файлы нельзя будет прослушать или вернуть. Всегда сохраняются последние версии веток, отмеченные версии и версии с открытыми комментариями."}
      </div>

      {error && <div className="error-text">{error}</div>}
      {!plan && !error && <div className="muted">Считаю…</div>}
      {plan && (
        <div className="notice">
          {plan.bytes === 0
            ? "Освобождать нечего."
            : [
                `Освободится ${formatSize(plan.bytes)}`,
                plan.versions > 0 &&
                  `${plan.versions} ${plural(plan.versions, "версия", "версии", "версий")} без веток`,
                plan.contents > 0 &&
                  `${plan.contents} ${plural(plan.contents, "старый файл", "старых файла", "старых файлов")}`,
              ]
                .filter(Boolean)
                .join(" · ")}
        </div>
      )}
    </Modal>
  );
}
