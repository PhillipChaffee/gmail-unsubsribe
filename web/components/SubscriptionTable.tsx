import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type FilterFn,
  type SortingFn,
  type SortingState,
  type Table,
} from "@tanstack/react-table";
import { useEffect, useEffectEvent, useMemo, useState } from "react";
import type { Method, Subscription } from "../../shared/types";
import { formatReceived } from "../format";
import { StatusCell } from "./StatusCell";

export interface SubscriptionTableProps {
  rows: Subscription[];
  /** Senders whose status was `unsubscribed` when the scan loaded (§3.3 Show unsubscribed). */
  hiddenAtLoad: ReadonlySet<string>;
  showUnsubscribed: boolean;
  /** Senders in a running job: shown as "Unsubscribing…" and not selectable. */
  pending: ReadonlySet<string>;
  selection: Record<string, boolean>;
  onSelectionChange: (s: Record<string, boolean>) => void;
  globalFilter: string;
  /** Selected rows that pass the search: the only rows an unsubscribe may act on (Review Focus 5). */
  onVisibleSelectedChange: (senders: string[]) => void;
  onManualDone: (sender: string) => void;
}

const METHOD_LABEL: Record<Method, string> = { "one-click": "One-click", mailto: "Email", manual: "Manual" };

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });
const byText: SortingFn<Subscription> = (a, b, id) => collator.compare(a.getValue<string>(id), b.getValue<string>(id));

/** Case-insensitive substring match on name, address or latest subject (§3.3). */
const matchesSearch: FilterFn<Subscription> = (row, _columnId, query: string) => {
  const q = query.toLowerCase();
  const { name, sender, latestSubject } = row.original;
  return name.toLowerCase().includes(q) || sender.toLowerCase().includes(q) || latestSubject.toLowerCase().includes(q);
};

const SORT_ARROW = { asc: "▲", desc: "▼" } as const;
const ARIA_SORT = { asc: "ascending", desc: "descending" } as const;

const col = createColumnHelper<Subscription>();

function SelectAll({ table }: { table: Table<Subscription> }) {
  const selectable = table.getFilteredRowModel().rows.filter((r) => r.getCanSelect());
  const selected = selectable.filter((r) => r.getIsSelected()).length;
  const all = selected > 0 && selected === selectable.length;
  return (
    <input
      type="checkbox"
      data-testid="select-all"
      aria-label="Select all shown senders"
      checked={all}
      disabled={selectable.length === 0}
      ref={(el) => {
        if (el) el.indeterminate = selected > 0 && !all;
      }}
      // v8 applies this to the rows that pass the current filter.
      onChange={table.getToggleAllRowsSelectedHandler()}
    />
  );
}

function SenderCell({ sub }: { sub: Subscription }) {
  return (
    <div className="sender-cell">
      <span className="sender-name" title={sub.name || sub.sender}>
        {sub.name || sub.sender}
      </span>
      {sub.name && (
        <span className="sender-address" title={sub.sender}>
          {sub.sender}
        </span>
      )}
    </div>
  );
}

export function SubscriptionTable(props: SubscriptionTableProps) {
  const { rows, hiddenAtLoad, showUnsubscribed, pending, selection, onSelectionChange, globalFilter, onManualDone } = props;
  const [sorting, setSorting] = useState<SortingState>([{ id: "count", desc: true }]);

  const data = useMemo(
    () => (showUnsubscribed ? rows : rows.filter((r) => !hiddenAtLoad.has(r.sender))),
    [rows, hiddenAtLoad, showUnsubscribed],
  );

  const columns = useMemo(
    () => [
      col.display({
        id: "select",
        header: ({ table }) => <SelectAll table={table} />,
        cell: ({ row }) => (
          <input
            type="checkbox"
            data-testid="row-checkbox"
            aria-label={`Select ${row.original.sender}`}
            checked={row.getIsSelected()}
            disabled={!row.getCanSelect()}
            onChange={row.getToggleSelectedHandler()}
          />
        ),
      }),
      col.accessor((r) => r.name || r.sender, {
        id: "sender",
        header: "Sender",
        sortingFn: byText,
        cell: ({ row }) => <SenderCell sub={row.original} />,
      }),
      col.accessor("count", { header: "Emails (30d)" }),
      col.accessor("lastReceived", {
        header: "Last received",
        cell: ({ getValue }) => <span title={new Date(getValue()).toLocaleString()}>{formatReceived(getValue(), Date.now())}</span>,
      }),
      col.accessor("latestSubject", {
        header: "Latest subject",
        sortingFn: byText,
        cell: ({ getValue }) => (
          <span className="subject" title={getValue()}>
            {getValue()}
          </span>
        ),
      }),
      col.accessor((r) => METHOD_LABEL[r.method], {
        id: "method",
        header: "Method",
        cell: ({ row }) => (
          <span className={`badge badge-${row.original.method}`} data-testid="method-badge">
            {METHOD_LABEL[row.original.method]}
          </span>
        ),
      }),
      col.accessor("status", {
        header: "Status",
        cell: ({ row }) => <StatusCell sub={row.original} pending={pending.has(row.id)} onManualDone={onManualDone} />,
      }),
    ],
    [pending, onManualDone],
  );

  const table = useReactTable({
    data,
    columns,
    state: { sorting, rowSelection: selection, globalFilter },
    getRowId: (r) => r.sender,
    onSortingChange: setSorting,
    onRowSelectionChange: (updater) => onSelectionChange(typeof updater === "function" ? updater(selection) : updater),
    enableRowSelection: (row) => !pending.has(row.id),
    enableSortingRemoval: false,
    globalFilterFn: matchesSearch,
    // matchesSearch reads the whole row, so it only needs to run once per row.
    getColumnCanGlobalFilter: (column) => column.id === "sender",
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  const visibleSelected = table
    .getFilteredRowModel()
    .rows.filter((r) => r.getIsSelected() && r.getCanSelect())
    .map((r) => r.id);
  const emitVisibleSelected = useEffectEvent((senders: string[]) => props.onVisibleSelectedChange(senders));
  // Keyed by content, not identity: the array is rebuilt on every render.
  const visibleSelectedKey = visibleSelected.join("\n");
  useEffect(() => {
    emitVisibleSelected(visibleSelected);
  }, [visibleSelectedKey]);

  const shown = table.getRowModel().rows;
  const empty =
    rows.length === 0
      ? "No subscriptions found in the last 30 days."
      : data.length === 0
        ? "Every sender here is already unsubscribed. Turn on Show unsubscribed to see them."
        : shown.length === 0
          ? "No senders match the search."
          : null;

  return (
    <div className="table-wrap">
      <table className="subscriptions" data-testid="subscriptions-table">
        <thead>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {group.headers.map((header) => {
                const { column } = header;
                const sorted = column.getIsSorted();
                const label = flexRender(column.columnDef.header, header.getContext());
                return (
                  <th
                    key={header.id}
                    className={`col-${column.id}`}
                    aria-sort={column.getCanSort() ? (sorted ? ARIA_SORT[sorted] : "none") : undefined}
                  >
                    {column.getCanSort() ? (
                      <button type="button" className="sort" data-testid={`sort-${column.id}`} onClick={column.getToggleSortingHandler()}>
                        {label}
                        <span className="sort-arrow" aria-hidden="true">
                          {sorted ? SORT_ARROW[sorted] : ""}
                        </span>
                      </button>
                    ) : (
                      label
                    )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {shown.map((row) => (
            <tr key={row.id} data-testid="row" data-sender={row.id} className={row.getIsSelected() ? "selected" : undefined}>
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id} className={`col-${cell.column.id}`}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
          {empty && (
            <tr>
              <td className="empty" colSpan={columns.length}>
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
