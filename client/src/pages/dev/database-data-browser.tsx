import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatBytes } from "@/lib/format-utils";
import {
  Loader2,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Table,
  Database,
  ArrowLeft,
  BarChart3,
} from "lucide-react";

interface TableSizeInfo {
  name: string;
  totalBytes: number;
  tableBytes: number;
  indexBytes: number;
  rowCount: number;
}

interface DbSizeData {
  totalBytes: number;
  tables: TableSizeInfo[];
}

function SizeBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.max(1, Math.round((value / max) * 100)) : 0;
  return (
    <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
      <div
        className="h-full bg-primary/60 rounded-full transition-all"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function DatabaseDataBrowser() {
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [view, setView] = useState<"list" | "sizes" | "browse">("list");

  const {
    data: sizeData,
    isLoading: sizeLoading,
    error: sizeError,
  } = useQuery<DbSizeData>({
    queryKey: ["/api/info/db/size"],
  });

  const { data: tableData, isLoading: tableLoading } = useQuery<{
    table: string;
    total: number;
    page: number;
    limit: number;
    rows: Record<string, unknown>[];
    columns: string[];
  }>({
    queryKey: ["/api/info/db/tables", selectedTable, page],
    enabled: !!selectedTable && view === "browse",
    queryFn: async () => {
      const res = await fetch(
        `/api/info/db/tables/${encodeURIComponent(selectedTable)}?page=${page}&limit=50`,
        { credentials: "include" }
      );
      if (!res.ok) {
        const text = (await res.text()) || res.statusText;
        throw new Error(`${res.status}: ${text}`);
      }
      return res.json();
    },
  });



  const selectTable = (name: string) => {
    setSelectedTable(name);
    setPage(0);
    setView("browse");
  };

  const totalPages = tableData ? Math.ceil(tableData.total / tableData.limit) : 0;
  const tables = sizeData?.tables.map((t) => t.name) ?? [];
  const maxTableSize = sizeData
    ? Math.max(...sizeData.tables.map((t) => t.totalBytes), 1)
    : 1;
  const sizeByName = new Map(sizeData?.tables.map((t) => [t.name, t]) ?? []);

  if (view === "browse" && selectedTable) {
    return (
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
        <div className="p-3 border-b border-border flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setView("list")}
              className="h-7 px-2"
              data-testid="button-db-back"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </Button>
            <Table className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium font-mono">{selectedTable}</span>
            {tableData && (
              <Badge variant="secondary" className="text-xs font-mono px-1 py-0">
                {tableData.total.toLocaleString()} rows
              </Badge>
            )}
            {sizeByName.get(selectedTable) && (
              <Badge
                variant="outline"
                className="text-xs font-mono"
                data-testid="badge-table-size"
              >
                {formatBytes(sizeByName.get(selectedTable)!.totalBytes)}
              </Badge>
            )}
          </div>
          {tableData && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="h-6 w-6 p-0"
                data-testid="button-db-prev"
              >
                <ChevronLeft className="h-3 w-3" />
              </Button>
              <span>
                Page {page + 1} / {Math.max(1, totalPages)}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setPage((p) => p + 1)}
                disabled={page >= totalPages - 1}
                className="h-6 w-6 p-0"
                data-testid="button-db-next"
              >
                <ChevronRight className="h-3 w-3" />
              </Button>
            </div>
          )}
        </div>
        <div className="flex-1 overflow-auto">
          {tableLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : tableData && tableData.rows.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-8">No rows</div>
          ) : tableData ? (
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="sticky top-0 bg-muted/50 backdrop-blur">
                  {tableData.columns.map((col) => (
                    <th
                      key={col}
                      className="text-left p-2 font-medium text-muted-foreground border-b border-border whitespace-nowrap font-mono"
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tableData.rows.map((row, ri) => (
                  <tr
                    key={ri}
                    data-testid={`row-db-${ri}`}
                    className="border-b border-border/50 hover:bg-accent/30"
                  >
                    {tableData.columns.map((col) => (
                      <td
                        key={col}
                        className="p-2 max-w-48 truncate font-mono text-muted-foreground"
                        title={String(row[col] ?? "")}
                      >
                        {row[col] === null ? (
                          <span className="text-muted-foreground/40 italic">null</span>
                        ) : typeof row[col] === "object" ? (
                          JSON.stringify(row[col]).slice(0, 80)
                        ) : (
                          String(row[col]).slice(0, 80)
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      </div>
    );
  }

  if (view === "sizes") {
    return (
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
        <div className="p-3 border-b border-border flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setView("list")}
            className="h-7 px-2"
            data-testid="button-sizes-back"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </Button>
          <Database className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Database Size</span>
          {sizeData && (
            <Badge
              variant="outline"
              className="font-mono text-xs"
              data-testid="badge-db-total-size"
            >
              {formatBytes(sizeData.totalBytes)}
            </Badge>
          )}
        </div>
        <div className="flex-1 overflow-auto">
          {sizeLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : sizeData ? (
            <div className="p-3 space-y-1" data-testid="panel-db-size-overview">
              {sizeData.tables.map((t) => (
                <button
                  key={t.name}
                  onClick={() => selectTable(t.name)}
                  className="w-full text-left rounded-lg px-3 py-2 hover:bg-accent/50 transition-colors"
                  data-testid={`button-sizetable-${t.name}`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-mono truncate mr-2">{t.name}</span>
                    <span className="text-xs text-muted-foreground font-mono shrink-0">
                      {formatBytes(t.totalBytes)}
                    </span>
                  </div>
                  <SizeBar value={t.totalBytes} max={maxTableSize} />
                  <div className="flex gap-3 mt-1">
                    <span className="text-xs text-muted-foreground">
                      {t.rowCount.toLocaleString()} rows
                    </span>
                    <span className="text-xs text-muted-foreground">
                      data: {formatBytes(t.tableBytes)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      idx: {formatBytes(t.indexBytes)}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 px-1 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <span>{sizeLoading ? "…" : tables.length} tables</span>
          {sizeData && (
            <Badge
              variant="outline"
              className="text-xs font-mono"
              data-testid="badge-db-total-size"
            >
              {formatBytes(sizeData.totalBytes)}
            </Badge>
          )}
        </div>
        <button
          type="button"
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-cta transition-colors hover:bg-accent/70 hover:text-cta/80"
          onClick={() => setView("sizes")}
          data-testid="button-view-sizes"
        >
          <BarChart3 className="h-3.5 w-3.5 shrink-0" />
          <span>Sizes</span>
        </button>
      </div>

        {sizeLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : sizeError ? (
          <div className="m-3 rounded-md border border-error/30 bg-error/5 p-3 text-sm text-error">
            <div className="flex items-center gap-2 font-medium">
              <AlertTriangle className="h-4 w-4" />
              Couldn&apos;t load database tables
            </div>
            <p className="mt-1 break-words text-xs text-error/80">
              {sizeError instanceof Error ? sizeError.message : String(sizeError)}
            </p>
          </div>
        ) : tables.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No database tables found.
          </div>
        ) : (
          <div className="space-y-1">
            {tables.map((t) => {
              const info = sizeByName.get(t);
              return (
                <button
                  key={t}
                  data-testid={`button-dbtable-${t}`}
                  onClick={() => selectTable(t)}
                  className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
                >
                  <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                  <Table className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{t}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    {info && (
                      <>
                        <span className="hidden text-xs text-muted-foreground min-[430px]:inline">
                          {info.rowCount.toLocaleString()} rows
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {formatBytes(info.totalBytes)}
                        </span>
                      </>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
    </div>
  );
}
