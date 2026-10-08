# takes

Контроль версий для любых файлов — как GitHub, но для музыки, графики, видео
и всего остального. Всё хранится локально.

Проект — обычная папка. Работаете в ней как обычно (DAW, Photoshop…), а takes
сохраняет версии, ведёт ветки и умеет сливать их.

## Структура

```
crates/
  takes-core/        ядро (библиотека): хранилище, версии, ветки, слияние
  takes-audio/       анализ аудио: волна и громкость (LUFS, EBU R128)
  takes-cli/         консольная утилита `takes` поверх ядра
apps/desktop/        десктоп-приложение (Tauri 2 + React + TypeScript)
  src/               интерфейс
  src-tauri/         Rust-команды поверх ядра, слежение за папкой
  dev/mock.html      интерфейс на фейковых данных, без бэкенда
```

## Десктоп-приложение

```sh
cd apps/desktop
npm install
npm run tauri dev       # запуск в режиме разработки
npm run tauri build     # установщики для текущей ОС
```

Что нужно для сборки:
- **Linux:** `libwebkit2gtk-4.1-dev librsvg2-dev` (для AppImage ещё `patchelf`);
- **Windows 10/11:** Visual Studio Build Tools (C++); WebView2 уже есть в системе;
- **macOS 10.15+:** Xcode Command Line Tools.

`npm run tauri` идёт через [scripts/tauri.mjs](apps/desktop/scripts/tauri.mjs):
он подхватывает `~/.cargo/bin`, если `cargo` нет в PATH, и на Linux убирает
GTK-переменные, которые протекают из терминала VS Code, установленного как
snap (иначе приложение падает с `symbol lookup error`).

### Выпуск версии для всех ОС

Каждую ОС собирает GitHub Actions на своей машине:

- [ci.yml](.github/workflows/ci.yml) — тесты и clippy на Linux, Windows и
  macOS при каждом push и pull request;
- [release.yml](.github/workflows/release.yml) — установщики для Linux
  (.deb, .rpm, .AppImage), Windows (.msi, .exe) и macOS (универсальный .dmg
  для Intel и Apple Silicon), прикреплённые к черновику релиза на GitHub.

```sh
# поднимите "version" в apps/desktop/src-tauri/tauri.conf.json, затем:
git tag v0.1.0
git push origin v0.1.0
```

Без подписи кода Windows покажет предупреждение SmartScreen, а macOS
потребует разрешить запуск в «Конфиденциальность и безопасность». Для подписи
macOS нужен Apple Developer ID — секреты перечислены в release.yml.

### Особенности ОС

- **Занятые файлы.** Windows не даёт заменить файл, открытый в другой
  программе. Перед переключением ветки, слиянием или восстановлением takes
  проверяет все затрагиваемые файлы и, если какой-то занят, ничего не меняет и
  говорит, какой файл закрыть.
- **Форматы в плеере** зависят от движка ОС: WAV и MP3 играют везде; FLAC —
  на Windows, macOS и Linux; OGG — на Windows и Linux (на macOS зависит от
версии Safari); AIFF — только на macOS.
  На Linux нужны плагины GStreamer (`gstreamer1.0-plugins-good`, для mp3 ещё
  `-ugly`).
- **Регистр имён.** На macOS и Windows `Song.wav` и `song.wav` — один файл;
  переименование только регистром видно как удаление и добавление.

Чтобы работать над интерфейсом без Rust, запустите `npm run dev` и откройте
http://localhost:1420/dev/mock.html в браузере.

## Как хранятся данные

```
МойАльбом/
├── 01 Intro.wav           ← обычные файлы
├── .takesignore           ← что не отслеживать (синтаксис .gitignore)
└── .takes/
    ├── objects/ab/cd…     ← куски файлов (FastCDC, BLAKE3, zstd)
    └── db.sqlite          ← версии, ветки, теги, комментарии
```

- **Дедупликация.** Файлы режутся на куски по содержимому (~1–2 МБ). Копия
  файла или правка в середине большого проекта не дублирует неизменённые куски.
- **Версия (snapshot)** — снимок всего проекта: путь → хэш содержимого.
  Ветка — указатель на версию. Слияние трёхстороннее, но по файлам: если файл
  изменён в обеих ветках, вы выбираете `ours`, `theirs` или `both` (второй
  вариант сохраняется рядом как `name (ветка).ext`).
- **Безопасность.** Переключение веток и восстановление никогда не затирают
  несохранённые файлы; файлы пишутся атомарно (temp + rename); каждый кусок
  проверяется по хэшу при чтении.

## Синхронизация

История проекта (не рабочая папка!) синхронизируется через «хранилище» —
любое место, где можно читать и писать файлы:

- **папка** — внутри Google Диска, Dropbox или Яндекс Диска (их приложение
  загрузит её в облако), на NAS или флешке;
- **WebDAV** — Яндекс Диск напрямую (`https://webdav.yandex.ru`, нужен
  пароль приложения), Nextcloud и др.

Кнопка «Синхронизировать» получает версии и комментарии других устройств,
перематывает ветки вперёд и отправляет свои версии. Если ветка изменилась на
двух устройствах, она появляется как `main@Студия` и сливается обычным
диалогом слияния. Несохранённые файлы никогда не перезаписываются.

Устройство формата: файлы в хранилище только добавляются (пакеты чанков по
~64 МБ, версии, комментарии), и каждое устройство пишет лишь свои ссылки на
ветки — поэтому не нужны блокировки, а прерванная отправка докачивается без
повторной загрузки. Всё скачанное проверяется по хэшам. Пароли WebDAV хранятся
в системной связке ключей. Подробности — в
[repo/sync.rs](crates/takes-core/src/repo/sync.rs).

```sh
takes remote folder ~/GoogleDrive/Takes/Альбом       # или:
takes remote webdav https://webdav.yandex.ru "Takes/Альбом" --user login
takes sync
takes clone ~/Music/Альбом webdav https://webdav.yandex.ru "Takes/Альбом" --user login
takes merge "main@Студия"                            # если ветки разошлись
```

## Использование

```sh
cargo build --release
alias takes=$PWD/target/release/takes

cd ~/Music/МойАльбом
takes init
takes config user.name "Имя"
takes status
takes commit -m "Первые демки"            # или takes save
takes commit -m "Новый припев" "02 Ночь"  # только часть файлов

takes switch -c acoustic                  # новая ветка
takes commit -m "Акустика"
takes switch main
takes merge acoustic --dry-run
takes merge acoustic --resolve "02 Ночь/mix.wav=both"

takes log                                 # история проекта
takes log --file "01 Intro.wav"           # история одного файла
takes restore "01 Intro.wav" --from HEAD~2 --as "01 Intro (old).wav"
takes export master-v1 "01 Intro.wav" ~/Desktop/intro.wav
takes tag master-v1
takes comment add "01 Intro.wav" "бочка громкая" --at 0:42
takes comment list
takes stats
```

Версию можно указать как `HEAD`, имя ветки, тег, начало id (`7ec0e8`) и
с отступом назад: `main~2`.

## Разработка

```sh
cargo test
cargo clippy --all-targets
```

## Дальше

- [x] Tauri-приложение: проекты, изменения, история, файлы, ветки, слияние, плеер
- [x] Аудиоплеер с волной и A/B-сравнением версий (с выравниванием по LUFS)
- [x] Комментарии на волне (привязаны к содержимому файла)
- [ ] Метаданные (BPM, тональность)
- [ ] Сборка мусора: удаление старых промежуточных версий
- [x] Синхронизация через папку (Google Диск, Dropbox, NAS) и WebDAV (Яндекс Диск)
- [ ] Шифрование хранилища, S3/R2, вход через Google
- [ ] Свой сервер: ссылки на прослушивание для группы и лейбла
