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

const params = new URLSearchParams(location.search);

const status: Change[] = params.has("clean")
  ? []
  : [
      { path: "01 Intro.wav", kind: "modified", size: null, pruned: false, labels: [] },
      { path: "02 Ночь/vocals_take3.wav", kind: "added", size: null, pruned: false, labels: [] },
      { path: "02 Ночь/lyrics.txt", kind: "modified", size: null, pruned: false, labels: [] },
      { path: "03 Рассвет/old_bounce.mp3", kind: "deleted", size: null, pruned: false, labels: [] },
      { path: "03 Рассвет/Рассвет Project/Рассвет.als", kind: "modified", size: null, pruned: false, labels: [] },
    ];

const files = [
  { path: "01 Intro.wav", size: 52_428_800, labels: ["мастер"] },
  { path: "02 Ночь/chords.pdf", size: 48_211, labels: [] },
  { path: "02 Ночь/demo.wav", size: 41_943_040, labels: ["сведение", "для лейбла"] },
  { path: "02 Ночь/lyrics.txt", size: 812, labels: [] },
  { path: "02 Ночь/lyrics (acoustic).txt", size: 790, labels: [] },
  { path: "03 Рассвет/old_bounce.mp3", size: 8_388_608, labels: ["демо"] },
  { path: "03 Рассвет/Рассвет Project/Рассвет.als", size: 734_003, labels: [] },
  { path: "cover.png", size: 2_516_582, labels: [] },
  { path: "tracklist.md", size: 420, labels: [] },
];

const lyrics = [
  "Куплет 1\nНочь опять не спит, и город в огне\nФонари горят где-то на дне\nЯ иду домой по пустой мостовой\n\nПрипев\nДо утра, до утра\nНе смыкая глаз\nДо утра, до утра\nЭта ночь для нас\n\nКуплет 2\nВетер шепчет мне чужие слова\nИ кружится в такт голова\n",
  "Куплет 1\nНочь опять не спит, и город в дыму\nФонари горят где-то на дне\nЯ иду домой по пустой мостовой\n\nПрипев\nДо утра, до утра\nНе смыкая глаз\nДо утра, до утра\nЭта ночь только для нас\n\nКуплет 2\nВетер шепчет мне знакомые слова\nИ кружится в такт голова\nИ кружится в такт голова\n",
];

/** A small PDF made on the fly: one page per chord chart line. */
function samplePdf(title: string): ArrayBuffer {
  const lines = ["Am      F       C       G", "Am      F       C       E", "Dm      Am      E       Am"];
  const stream = [
    "BT /F1 26 Tf 60 760 Td (" + title + ") Tj ET",
    ...lines.map((l, i) => `BT /F2 16 Tf 60 ${700 - i * 34} Td (${l}) Tj ET`),
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf).buffer;
}

/** Two versions of a cover, drawn on a canvas. */
function sampleCover(variant: number): string {
  const c = document.createElement("canvas");
  c.width = 600;
  c.height = 600;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 600, 600);
  grad.addColorStop(0, variant ? "#1d2b64" : "#3a1c71");
  grad.addColorStop(1, variant ? "#f8cdda" : "#ffaf7b");
  g.fillStyle = grad;
  g.fillRect(0, 0, 600, 600);
  g.fillStyle = "rgba(255,255,255,0.9)";
  g.beginPath();
  g.arc(variant ? 420 : 300, variant ? 200 : 260, variant ? 90 : 120, 0, Math.PI * 2);
  g.fill();
  g.font = "bold 54px sans-serif";
  g.fillText("НОЧНОЙ АЛЬБОМ", 40, 540);
  return c.toDataURL("image/png");
}

const preview: MergePreview = {
  kind: "merge",
  changes: [
    { path: "02 Ночь/guitar_di.wav", kind: "added", size: null, pruned: false },
    { path: "cover.png", kind: "modified", size: null, pruned: false },
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
// Generated samples stand in for files the mock cannot read.
const internals = (window as unknown as { __TAURI_INTERNALS__: { convertFileSrc: (p: string, s?: string) => string } })
  .__TAURI_INTERNALS__;
const convert = internals.convertFileSrc;
internals.convertFileSrc = (path, scheme) =>
  path.startsWith("mock:cover:") ? sampleCover(Number(path.slice(-1))) : convert(path, scheme);
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
          { path: "02 Ночь/lyrics.txt", kind: "modified", size: 812, pruned: false, labels: [] },
          { path: "02 Ночь/chords.pdf", kind: "modified", size: 48_211, pruned: false, labels: [] },
          { path: "02 Ночь/guitar_di.wav", kind: "added", size: 39_845_888, pruned: false, labels: ["демо"] },
          { path: "02 Ночь/vocal_take1.wav", kind: "modified", size: 31_457_280, pruned: true, labels: [] },
          { path: "cover.png", kind: "modified", size: 2_516_582, pruned: false, labels: ["финал"] },
          { path: "03 Рассвет/old_take.wav", kind: "deleted", size: null, pruned: false, labels: [] },
        ];
      case "files":
        return files;
      case "file_history":
        return log.slice(1).map((snapshot, i) => ({
          snapshot,
          kind: i === log.length - 2 ? "added" : "modified",
          size: 50_000_000 + i * 1_200_000,
          pruned: i === 2 || i === 3,
          labels: i === 0 ? ["мастер"] : i === 1 ? ["сведение"] : i === 4 ? ["демо"] : [],
        }));
      case "merge_preview":
        return preview;
      case "preview_file":
        return String(a.path).endsWith(".png") ? `mock:cover:${a.rev === id(5) || a.rev === id(6) ? 1 : 0}` : `/tmp/${a.path}`;
      case "text_file":
        return { text: lyrics[a.rev === id(5) ? 0 : 1], truncated: false };
      case "file_bytes":
        return samplePdf(a.rev === id(6) ? "Noch - chords v2" : "Noch - chords");
      case "file_meta":
        return { labels: ["мастер"], bpm: 128, key: null };
      case "set_file_meta":
        return null;
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
          bpm: 127.8,
          key: "Am",
          manualBpm: working ? null : 128,
          manualKey: null,
        };
      }
      case "sync_state":
        return new URLSearchParams(location.search).has("nosync")
          ? { remote: null, location: null, hasPassword: false, deviceName: "nikita-laptop", unsentVersions: 0, diverged: [], waiting: [], lastSync: null, auto: true }
          : {
              remote: { kind: "webDav", url: "https://webdav.yandex.ru", folder: "Takes/Ночной альбом", username: "nikita" },
              location: "https://webdav.yandex.ru/Takes/Ночной альбом",
              hasPassword: true,
              deviceName: "Ноутбук",
              unsentVersions: 2,
              diverged: params.has("waiting") ? [] : [{ branch: "main", device: "Студия", rev: "main@Студия" }],
              waiting: params.has("waiting") ? ["main"] : [],
              lastSync: now - 3600,
              auto: true,
            };
      case "cleanup":
        return a.olderThanDays === null
          ? { versions: 3, contents: 0, bytes: 96_000_000 }
          : { versions: 3, contents: 14, bytes: 1_240_000_000 };
      case "sync":
      case "update_current":
        return {
          uploadedBytes: 0, downloadedBytes: 0, sentVersions: 0, receivedVersions: 0, commentsSent: 0,
          commentsReceived: 0, updatedBranches: [], newBranches: [], deletedBranches: [], diverged: [],
          currentBlocked: null, blockedPaths: [],
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
