import { PIN_Y, wire, type Point } from "../../blueprint";
import type { Pull } from "./model";

/** An execution pin, filled when a wire is attached; a wire can be pulled from it. */
export function ExecPin({ side, on, onPull }: { side: "in" | "out"; on: boolean; onPull?: (e: React.PointerEvent) => void }) {
  return (
    <svg
      className={`bp-pin bp-pin-${side} ${on ? "on" : ""} ${onPull ? "pullable" : ""}`}
      width="21"
      height="23"
      viewBox="-4 -4 21 23"
      style={{ top: PIN_Y - 11.5 }}
      data-pin={side}
      onPointerDown={onPull}
    >
      {onPull && <title>Тащите, чтобы провести провод; Alt + щелчок — оборвать</title>}
      <rect className="bp-pin-hit" x="-4" y="-4" width="21" height="23" />
      <path d="M1.5 1.5h5.5l4.5 6-4.5 6h-5.5z" />
    </svg>
  );
}

/** The wire being pulled: from the pin that stays to the pointer, or to the pin under it. */
export function LiveWire({
  pull,
  pinAt,
}: {
  pull: Pull;
  pinAt: (lane: string, key: string, side: "in" | "out") => Point | null;
}) {
  const fixed = pinAt(pull.fixed.lane, pull.fixed.key, pull.fixed.side);
  if (!fixed) return null;
  const end = (pull.target && pinAt(pull.target.lane, pull.target.key, pull.target.side)) || pull.at;
  const d = pull.fixed.side === "out" ? wire(fixed.x, fixed.y, end.x, end.y) : wire(end.x, end.y, fixed.x, fixed.y);
  return (
    <svg className="bp-live" width="1" height="1">
      <path d={d} className={`bp-wire live ${pull.target && !pull.ok ? "bad" : ""}`} />
    </svg>
  );
}
