import { useEffect, useState } from "react";
import { api, errorText, type FileMeta } from "../api";
import { Modal, sortLabels, useToast } from "../ui";
import { isAudio, LABEL_PRESETS, splitPath } from "../util";

/** Labels, tempo and key of one saved file version. */
export function FileMetaDialog({
  root,
  rev,
  path,
  versionLabel,
  onClose,
  onSaved,
}: {
  root: string;
  rev: string;
  path: string;
  /** Which version, e.g. "версия 1a2b3c4d". */
  versionLabel: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [meta, setMeta] = useState<FileMeta | null>(null);
  const [custom, setCustom] = useState("");
  const [bpm, setBpm] = useState("");
  const [key, setKey] = useState("");
  const [estimate, setEstimate] = useState<{ bpm: number | null; key: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const audio = isAudio(path);

  useEffect(() => {
    let alive = true;
    api
      .fileMeta(root, rev, path)
      .then((m) => {
        if (!alive) return;
        setMeta(m);
        setBpm(m.bpm?.toString() ?? "");
        setKey(m.key ?? "");
      })
      .catch((e) => alive && setError(errorText(e)));
    // The estimate as a hint; cached after the first listen.
    if (audio) {
      api
        .analyzeAudio(root, rev, path)
        .then((a) => alive && setEstimate({ bpm: a.bpm, key: a.key }))
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [root, rev, path, audio]);

  const labels = meta?.labels ?? [];
  const toggle = (label: string) =>
    setMeta((m) =>
      m && { ...m, labels: m.labels.includes(label) ? m.labels.filter((l) => l !== label) : [...m.labels, label] },
    );
  function addCustom() {
    const label = custom.trim();
    if (!label) return;
    if (!labels.includes(label)) toggle(label);
    setCustom("");
  }

  async function save() {
    if (!meta) return;
    const tempo = bpm.trim() ? Number(bpm.replace(",", ".")) : null;
    if (tempo !== null && !(tempo >= 20 && tempo <= 400)) {
      setError("Темп — число от 20 до 400.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.setFileMeta(root, rev, path, { labels, bpm: tempo, key: key.trim() || null });
      toast("Метки сохранены", "ok");
      onSaved();
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const options = sortLabels([...new Set([...LABEL_PRESETS, ...labels])]);
  return (
    <Modal
      title={`Метки · ${splitPath(path).name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Отмена
          </button>
          <button className="btn btn-primary" disabled={!meta || busy} onClick={save}>
            {busy ? "Сохраняю…" : "Сохранить"}
          </button>
        </>
      }
    >
      <div className="muted">{versionLabel}</div>
      <div className="label-picker">
        {options.map((l) => {
          const preset = LABEL_PRESETS.indexOf(l);
          return (
            <button
              key={l}
              className={`file-label ${preset >= 0 ? `file-label-${preset}` : ""} ${labels.includes(l) ? "on" : ""}`}
              disabled={!meta}
              onClick={() => toggle(l)}
            >
              {l}
            </button>
          );
        })}
      </div>
      <div className="field-row align-end">
        <label className="field">
          <span>Своя метка</span>
          <input
            value={custom}
            maxLength={40}
            placeholder="Например: для лейбла"
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addCustom()}
          />
        </label>
        <button className="btn" disabled={!custom.trim() || !meta} onClick={addCustom}>
          Добавить
        </button>
      </div>
      {audio && (
        <div className="field-row">
          <label className="field">
            <span>Темп, BPM</span>
            <input
              inputMode="decimal"
              value={bpm}
              placeholder={estimate?.bpm != null ? `≈${Math.round(estimate.bpm)}, определено` : "например, 128"}
              onChange={(e) => setBpm(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Тональность</span>
            <input
              value={key}
              maxLength={12}
              placeholder={estimate?.key ? `${estimate.key}, определено` : "например, Am"}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
        </div>
      )}
      <div className="hint">
        Метки привязаны к содержимому файла: они видны во всех версиях, где файл не менялся, и уходят на другие
        устройства при синхронизации.
      </div>
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}
