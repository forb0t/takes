import { useEffect, useRef, useState } from "react";
import { Icon } from "../../ui";
import type { Actions, Tile } from "./model";
import { ExecPin } from "./pins";

/** A note, a song to come or a frame: dragged around, resized, written in. */
export function TileView({
  tile,
  selected,
  editing,
  dim,
  act,
}: {
  tile: Tile;
  selected: boolean;
  editing: boolean;
  dim: boolean;
  act: React.RefObject<Actions>;
}) {
  const el = useRef<HTMLDivElement>(null);
  const [title, setTitle] = useState(tile.title);
  const [text, setText] = useState(tile.text);

  useEffect(() => {
    if (!editing) {
      setTitle(tile.title);
      setText(tile.text);
    }
  }, [editing, tile.title, tile.text]);

  // A file dropped on a song to come from the file manager becomes that song.
  useEffect(() => {
    const node = el.current;
    if (!node || tile.kind !== "song") return;
    const onDrop = (e: Event) => {
      const [first] = (e as CustomEvent<string[]>).detail;
      if (first) act.current.fillTile(tile, first);
    };
    node.addEventListener("filedrop", onDrop);
    return () => node.removeEventListener("filedrop", onDrop);
  }, [tile, act]);

  function done() {
    if (title.trim() !== tile.title || text !== tile.text) {
      act.current.updateTile(tile.id, { title: title.trim() || tile.title, text });
    }
    act.current.editTile(null);
  }

  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setTitle(tile.title);
      setText(tile.text);
      act.current.editTile(null);
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey || (e.target as HTMLElement).tagName === "INPUT")) {
      e.preventDefault();
      done();
    }
  };

  const titleField = editing ? (
    <input
      className="bp-tile-input"
      autoFocus
      value={title}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setTitle(e.target.value)}
      onKeyDown={keys}
      onBlur={(e) => !el.current?.contains(e.relatedTarget as Node) && done()}
    />
  ) : (
    <span className="bp-title">{tile.title}</span>
  );

  const common = {
    ref: el,
    style: {
      left: tile.x,
      top: tile.y,
      width: tile.w,
      height: tile.h,
      ["--hue" as string]: tile.color,
    },
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      act.current.selectTile(tile.id);
    },
    onDoubleClick: () => act.current.editTile(tile.id),
    onContextMenu: (e: React.MouseEvent) => act.current.tileMenu(e, tile),
  };
  const resize = <span className="bp-resize" onPointerDown={(e) => act.current.sizeTile(e, tile)} />;

  if (tile.kind === "frame") {
    return (
      <div {...common} className={`bp-group ${selected ? "selected" : ""} ${dim ? "dim" : ""}`}>
        <div className="bp-group-title" onPointerDown={(e) => act.current.dragTile(e, tile)}>
          {titleField}
        </div>
        {resize}
      </div>
    );
  }

  const body = editing ? (
    <textarea
      className="bp-tile-text"
      value={text}
      placeholder={tile.kind === "song" ? "Идея, текст, что записать…" : "Текст заметки"}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={keys}
      onBlur={(e) => !el.current?.contains(e.relatedTarget as Node) && done()}
    />
  ) : (
    <div className="bp-tile-body">{tile.text || <i>{tile.kind === "song" ? "заготовка без файла" : "пусто"}</i>}</div>
  );

  if (tile.kind === "song") {
    return (
      <div
        {...common}
        data-file-drop
        className={`bp-node bp-placeholder ${selected ? "selected" : ""} ${dim ? "dim" : ""}`}
        onPointerDown={(e) => act.current.dragTile(e, tile)}
      >
        <div className="bp-node-head">
          <span className="bp-event" />
          {titleField}
          <span className="bp-state">заготовка</span>
        </div>
        {body}
        <div className="bp-tile-foot">
          <button className="btn btn-small" onClick={() => act.current.fillTile(tile)}>
            <Icon name="folder" size={13} /> Выбрать файл…
          </button>
          <span className="muted">или бросьте файл сюда</span>
        </div>
        <ExecPin side="out" on={false} />
        {resize}
      </div>
    );
  }

  return (
    <div
      {...common}
      className={`bp-node bp-note ${selected ? "selected" : ""} ${dim ? "dim" : ""}`}
      onPointerDown={(e) => act.current.dragTile(e, tile)}
    >
      <div className="bp-node-head">
        <Icon name="comment" size={12} />
        {titleField}
      </div>
      {body}
      {resize}
    </div>
  );
}
