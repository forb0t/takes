// UI preview with fake data, no Rust backend: run `npm run dev` and open
// http://localhost:1420/dev/mock.html in a browser.

import { mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import type { Change, MergePreview, Overview, Snapshot } from "../src/api";

const root = "/home/me/Music/Ночной альбом";
const now = Math.floor(Date.now() / 1000);
const id = (n: number) => n.toString(16).padStart(2, "0").repeat(32);

const log: Snapshot[] = [
  { id: id(6), parents: [id(5), id(4)], message: "Merge 'acoustic' into 'main'", author: "nikita", createdAt: now - 600 },
  { id: id(5), parents: [id(3)], message: "Ночь: новый текст второго куплета", author: "nikita", createdAt: now - 3600 * 3 },
  { id: id(4), parents: [id(3)], message: "Акустическая версия «Ночи»: гитара + вокал", author: "masha", createdAt: now - 3600 * 26 },
  { id: id(3), parents: [id(2)], message: "Intro: переписал синты, убрал лишний пад", author: "nikita", createdAt: now - 86400 * 3 },
  { id: id(2), parents: [id(1)], message: "Добавил обложку и черновик трек-листа", author: "nikita", createdAt: now - 86400 * 9 },
  { id: id(1), parents: [], message: "Первые демки", author: "nikita", createdAt: now - 86400 * 30 },
];

const overview: Overview = {
  root,
  name: "Ночной альбом",
  branch: "main",
  head: id(6),
  author: "nikita",
  branches: [
    { name: "acoustic", head: id(4), current: false },
    { name: "main", head: id(6), current: true },
    { name: "remix-feat-dj", head: id(3), current: false },
  ],
  tags: [{ name: "demo-v1", target: id(3) }],
};

const status: Change[] = [
  { path: "01 Intro.wav", kind: "modified", size: null },
  { path: "02 Ночь/vocals_take3.wav", kind: "added", size: null },
  { path: "02 Ночь/lyrics.txt", kind: "modified", size: null },
  { path: "03 Рассвет/old_bounce.mp3", kind: "deleted", size: null },
  { path: "03 Рассвет/Рассвет Project/Рассвет.als", kind: "modified", size: null },
];

const files = [
  { path: "01 Intro.wav", size: 52_428_800 },
  { path: "02 Ночь/demo.wav", size: 41_943_040 },
  { path: "02 Ночь/lyrics.txt", size: 812 },
  { path: "02 Ночь/lyrics (acoustic).txt", size: 790 },
  { path: "03 Рассвет/old_bounce.mp3", size: 8_388_608 },
  { path: "03 Рассвет/Рассвет Project/Рассвет.als", size: 734_003 },
  { path: "cover.png", size: 2_516_582 },
  { path: "tracklist.md", size: 420 },
];

const preview: MergePreview = {
  kind: "merge",
  changes: [
    { path: "02 Ночь/guitar_di.wav", kind: "added", size: null },
    { path: "cover.png", kind: "modified", size: null },
  ],
  conflicts: [
    { path: "02 Ночь/demo.wav", ours: { blob: id(9), size: 41_943_040 }, theirs: { blob: id(10), size: 39_845_888 } },
    { path: "02 Ночь/lyrics.txt", ours: { blob: id(11), size: 812 }, theirs: null },
  ],
};

/** A plausible song shape: intro, verses, louder choruses, outro. */
function fakeWave(seed: number, loudness: number) {
  const n = 1600;
  const peaks: number[] = [];
  const rms: number[] = [];
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const noise = (x / 2147483648) * 0.25;
    const t = i / n;
    const section = t < 0.08 ? 0.3 : t < 0.3 ? 0.55 : t < 0.45 ? 0.85 : t < 0.65 ? 0.6 : t < 0.85 ? 0.9 : 0.35 * (1 - (t - 0.85) / 0.15);
    const beat = 0.85 + 0.15 * Math.sin(i * 0.9);
    const p = Math.min(1, (section * beat + noise) * loudness);
    peaks.push(Math.round(p * 255));
    rms.push(Math.round(p * 0.55 * 255));
  }
  return { peaks, rms };
}

const comments = [
  { id: 1, snapshot: id(6), path: "01 Intro.wav", timecodeMs: 42_000, text: "Бочка слишком громкая, съедает бас", author: "masha", createdAt: now - 7200, resolved: false },
  { id: 2, snapshot: id(6), path: "01 Intro.wav", timecodeMs: 95_500, text: "Вот тут классный переход!", author: "nikita", createdAt: now - 5000, resolved: false },
  { id: 3, snapshot: id(6), path: "01 Intro.wav", timecodeMs: 150_000, text: "Пад слишком широкий", author: "masha", createdAt: now - 86400, resolved: true },
];

mockConvertFileSrc("linux");
mockIPC(
  (cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "list_projects":
        return [
          { path: root, name: "Ночной альбом", exists: true },
          { path: "/home/me/Music/EP 2025", name: "EP 2025", exists: true },
          { path: "/home/me/Design/Обложки", name: "Обложки", exists: false },
        ];
      case "overview":
        return overview;
      case "stats":
        return { snapshots: 6, contentBytes: 420_000_000, storedBytes: 185_000_000 };
      case "status":
        return status;
      case "log":
        return a.rev === "acoustic" ? log.filter((s) => [4, 3, 2, 1].includes(parseInt(s.id.slice(0, 2), 16))) : log;
      case "snapshot_changes":
        return [
          { path: "02 Ночь/lyrics.txt", kind: "modified", size: 812 },
          { path: "02 Ночь/guitar_di.wav", kind: "added", size: 39_845_888 },
          { path: "03 Рассвет/old_take.wav", kind: "deleted", size: null },
        ];
      case "files":
        return files;
      case "file_history":
        return log.slice(1).map((snapshot, i) => ({
          snapshot,
          kind: i === log.length - 2 ? "added" : "modified",
          size: 50_000_000 + i * 1_200_000,
        }));
      case "merge_preview":
        return preview;
      case "preview_file":
        return `/tmp/${a.path}`;
      case "watch_project":
        return null;
      case "analyze_audio": {
        const working = a.rev === null;
        return {
          blob: id(working ? 20 : 21),
          durationMs: 198_000,
          sampleRate: 48_000,
          channels: 2,
          ...fakeWave(working ? 7 : 3, working ? 1 : 0.7),
          lufs: working ? -9.4 : -13.1,
        };
      }
      case "sync_state":
        return new URLSearchParams(location.search).has("nosync")
          ? { remote: null, location: null, hasPassword: false, deviceName: "nikita-laptop", unsentVersions: 0, diverged: [], waiting: [], lastSync: null }
          : {
              remote: { kind: "webDav", url: "https://webdav.yandex.ru", folder: "Takes/Ночной альбом", username: "nikita" },
              location: "https://webdav.yandex.ru/Takes/Ночной альбом",
              hasPassword: true,
              deviceName: "Ноутбук",
              unsentVersions: 2,
              diverged: [{ branch: "main", device: "Студия", rev: "main@Студия" }],
              waiting: [],
              lastSync: now - 3600,
            };
      case "find_remote_projects":
        return ["Ночной альбом", "EP 2025"];
      case "comments":
        return a.rev === null ? [] : comments;
      case "add_comment":
        return 4;
      default:
        console.info("mock: unhandled", cmd, a);
        return null;
    }
  },
  { shouldMockEvents: true },
);

await import("../src/main");
