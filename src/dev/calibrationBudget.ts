import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { digest } from "../router/knowledge/evidenceRegistry.js";
const units = (usd: number) => {
  if (!Number.isFinite(usd) || usd < 0) throw Error("Invalid budget amount");
  const n = Math.ceil(usd * 1e9);
  if (!Number.isSafeInteger(n)) throw Error("Budget amount overflow");
  return n;
};
type Event = {
  sequence: number;
  previous: string;
  digest: string;
  type: "reserve" | "settle";
  id: string;
  cell: string;
  amount: number;
  uncertain?: boolean;
};
/** A single experiment coordinator owns this fsynced ledger. Cross-process exclusion is held by the experiment lock. */
export class CalibrationBudget {
  private queue: Promise<unknown> = Promise.resolve();
  private rows: Event[] = [];
  private requests = new Map<
    string,
    { cell: string; reserved: number; charged?: number }
  >();
  private constructor(
    readonly path: string,
    readonly cap: number,
    readonly cellCap: number,
  ) {}
  static async load(path: string, capUsd: number, cellCapUsd: number) {
    const b = new CalibrationBudget(path, units(capUsd), units(cellCapUsd));
    await mkdir(dirname(path), { recursive: true });
    const text = await readFile(path, "utf8").catch((e) => {
      if (e.code !== "ENOENT") throw e;
      return "";
    });
    if (text && !text.endsWith("\n"))
      throw Error("Truncated budget ledger; reconcile before resuming");
    for (const line of text.split("\n").filter(Boolean)) {
      const e = JSON.parse(line) as Event;
      const { digest: hash, ...body } = e;
      if (
        hash !== digest(body) ||
        e.sequence !== b.rows.length ||
        e.previous !== (b.rows.at(-1)?.digest ?? "root")
      )
        throw Error("Budget ledger integrity failure");
      b.apply(e);
      b.rows.push(e);
    }
    if (
      [...new Set([...b.requests.values()].map((r) => r.cell))].some(
        (cell) => b.exposure(cell) > b.cellCap,
      )
    )
      throw Error("Cell ledger exceeds approved cap");
    if (b.exposure() > b.cap) throw Error("Budget ledger exceeds approved cap");
    return b;
  }
  private apply(e: Event) {
    if (!Number.isSafeInteger(e.amount) || e.amount < 0)
      throw Error("Invalid ledger charge");
    const old = this.requests.get(e.id);
    if (e.type === "reserve") {
      if (old) throw Error("Duplicate reservation");
      this.requests.set(e.id, { cell: e.cell, reserved: e.amount });
    } else {
      if (
        !old ||
        old.cell !== e.cell ||
        old.charged !== undefined ||
        e.amount > old.reserved
      )
        throw Error("Invalid settlement or provider exceeded reserved maximum");
      old.charged = e.amount;
    }
  }
  private exposure(cell?: string) {
    return [...this.requests.values()]
      .filter((r) => !cell || r.cell === cell)
      .reduce((s, r) => s + (r.charged ?? r.reserved), 0);
  }
  private async append(
    type: Event["type"],
    id: string,
    cell: string,
    amount: number,
    uncertain = false,
  ) {
    const body = {
      sequence: this.rows.length,
      previous: this.rows.at(-1)?.digest ?? "root",
      type,
      id,
      cell,
      amount,
      uncertain,
    };
    const e = { ...body, digest: digest(body) };
    const file = await open(this.path, "a");
    try {
      await file.writeFile(JSON.stringify(e) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    this.apply(e);
    this.rows.push(e);
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => {});
    return next;
  }
  reserve(id: string, cell: string, maxUsd: number) {
    return this.serial(async () => {
      if (this.requests.has(id))
        throw Error("Attempt already reserved; cannot bill twice");
      const amount = units(maxUsd);
      if (
        this.exposure() + amount > this.cap ||
        this.exposure(cell) + amount > this.cellCap
      )
        throw Error("CALIBRATION_BUDGET_EXHAUSTED before provider dispatch");
      await this.append("reserve", id, cell, amount);
      return id;
    });
  }
  settle(id: string, actualUsd?: number) {
    return this.serial(async () => {
      const old = this.requests.get(id);
      if (!old) throw Error("Unknown attempt");
      const charge = actualUsd === undefined ? old.reserved : units(actualUsd);
      if (charge > old.reserved)
        throw Error(
          "Provider exceeded reserved maximum; reconcile before further dispatch",
        );
      if (old.charged !== undefined) {
        if (old.charged !== charge) throw Error("Settlement mismatch");
        return;
      }
      await this.append(
        "settle",
        id,
        old.cell,
        charge,
        actualUsd === undefined,
      );
    });
  }
  snapshot() {
    return {
      maximumUsd: this.cap / 1e9,
      exposureUsd: this.exposure() / 1e9,
      remainingUsd: (this.cap - this.exposure()) / 1e9,
      calls: this.requests.size,
      unresolved: [...this.requests]
        .filter(([, r]) => r.charged === undefined)
        .map(([id]) => id),
    };
  }
}
