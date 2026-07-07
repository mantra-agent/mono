import { useState, useCallback, useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Upload, FileText, ArrowRight, ArrowLeft, Check, AlertCircle, Loader2 } from "lucide-react";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface CSVPreviewResponse {
  headers: string[];
  rowCount: number;
  sampleRows: string[][];
  preview: { date: string; description: string; amount: number }[] | null;
}

interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

interface PlaidAccountItem {
  accountId: string;
  itemId: string;
  institutionName: string;
  accounts: Array<{
    accountId: string;
    name: string;
    type: string;
    currentBalance: number | null;
  }>;
}

type Step = "upload" | "mapping" | "preview" | "result";

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(value);
}

export function CSVImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [step, setStep] = useState<Step>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [csvData, setCsvData] = useState<CSVPreviewResponse | null>(null);
  const [dateCol, setDateCol] = useState<number>(0);
  const [descCol, setDescCol] = useState<number>(1);
  const [amountCol, setAmountCol] = useState<number>(2);
  const [useDebitCredit, setUseDebitCredit] = useState(false);
  const [debitCol, setDebitCol] = useState<number>(0);
  const [creditCol, setCreditCol] = useState<number>(1);
  const [accountId, setAccountId] = useState("manual-import");
  const [customAccountName, setCustomAccountName] = useState("");
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [previewRows, setPreviewRows] = useState<{ date: string; description: string; amount: number }[]>([]);
  const [isUploading, setIsUploading] = useState(false);

  const accountsQuery = useQuery<PlaidAccountItem[]>({
    queryKey: ["/api/plaid/accounts"],
  });

  const allAccounts = useMemo(() => {
    const accs: { id: string; label: string }[] = [{ id: "manual-import", label: "New manual import account" }];
    if (accountsQuery.data) {
      for (const item of accountsQuery.data) {
        for (const acc of item.accounts) {
          accs.push({ id: acc.accountId, label: `${item.institutionName} - ${acc.name}` });
        }
      }
    }
    return accs;
  }, [accountsQuery.data]);

  const reset = useCallback(() => {
    setStep("upload");
    setFile(null);
    setCsvData(null);
    setDateCol(0);
    setDescCol(1);
    setAmountCol(2);
    setUseDebitCredit(false);
    setDebitCol(0);
    setCreditCol(1);
    setAccountId("manual-import");
    setCustomAccountName("");
    setImportResult(null);
    setPreviewRows([]);
    setIsUploading(false);
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [onClose, reset]);

  const handleFileSelect = useCallback(async (selectedFile: File) => {
    setFile(selectedFile);
    setIsUploading(true);

    const formData = new FormData();
    formData.append("file", selectedFile);

    try {
      const res = await fetch("/api/finance/import-csv/preview", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setCsvData(data);

      if (data.headers.length > 0) {
        const lowerHeaders = data.headers.map((h: string) => h.toLowerCase().trim());
        const dateIdx = lowerHeaders.findIndex((h: string) => /date|posted|trans.*date/i.test(h));
        const descIdx = lowerHeaders.findIndex((h: string) => /desc|merchant|name|memo|payee|narration/i.test(h));
        const amtIdx = lowerHeaders.findIndex((h: string) => /^amount$|^total$/i.test(h));
        const debitIdx = lowerHeaders.findIndex((h: string) => /debit|withdrawal|charge/i.test(h));
        const creditIdx = lowerHeaders.findIndex((h: string) => /credit|deposit/i.test(h));

        if (dateIdx >= 0) setDateCol(dateIdx);
        if (descIdx >= 0) setDescCol(descIdx);
        if (amtIdx >= 0) {
          setAmountCol(amtIdx);
          setUseDebitCredit(false);
        } else if (debitIdx >= 0 && creditIdx >= 0) {
          setDebitCol(debitIdx);
          setCreditCol(creditIdx);
          setUseDebitCredit(true);
        }
      }

      setStep("mapping");
    } catch (err) {
      toast({ title: "Failed to parse CSV", description: String(err), variant: "destructive" });
    } finally {
      setIsUploading(false);
    }
  }, [toast]);

  const handlePreview = useCallback(async () => {
    if (!file || !csvData) return;
    setIsUploading(true);

    const mapping = useDebitCredit
      ? { date: dateCol, description: descCol, debit: debitCol, credit: creditCol }
      : { date: dateCol, description: descCol, amount: amountCol };

    const formData = new FormData();
    formData.append("file", file);
    formData.append("mapping", JSON.stringify(mapping));

    try {
      const res = await fetch("/api/finance/import-csv/preview", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setPreviewRows(data.preview || []);
      setStep("preview");
    } catch (err) {
      toast({ title: "Preview failed", description: String(err), variant: "destructive" });
    } finally {
      setIsUploading(false);
    }
  }, [file, csvData, useDebitCredit, dateCol, descCol, amountCol, debitCol, creditCol, toast]);

  const importMutation = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("No file");

      const resolvedAccountId = accountId === "manual-import"
        ? `manual-import-${(customAccountName || "bank").replace(/\s+/g, "-").toLowerCase()}`
        : accountId;

      const mapping = useDebitCredit
        ? { date: dateCol, description: descCol, debit: debitCol, credit: creditCol }
        : { date: dateCol, description: descCol, amount: amountCol };

      const formData = new FormData();
      formData.append("file", file);
      formData.append("mapping", JSON.stringify(mapping));
      formData.append("accountId", resolvedAccountId);
      formData.append("itemId", "csv-import");

      const res = await fetch("/api/finance/import-csv", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Import failed" }));
        throw new Error(body.error || "Import failed");
      }
      return res.json();
    },
    onSuccess: (data: ImportResult) => {
      setImportResult(data);
      setStep("result");
      queryClient.invalidateQueries({ queryKey: ["/api/plaid/transactions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance"] });
    },
    onError: (err: Error) => {
      toast({ title: "Import failed", description: err.message, variant: "destructive" });
    },
  });

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" data-testid="csv-import-overlay">
      <div className="absolute inset-0 bg-black/50" onClick={handleClose} />
      <div className="relative bg-card border border-border rounded-lg shadow-xl w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col" data-testid="csv-import-dialog">
        <div className="px-5 py-4 border-b border-border/50 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold">Import Bank CSV</h2>
          </div>
          <button onClick={handleClose} className="text-xs text-muted-foreground hover:text-foreground" data-testid="button-close-csv-import">&times;</button>
        </div>

        <div className="px-5 py-3 border-b border-border/30 flex items-center gap-2 text-xs text-muted-foreground">
          {(["upload", "mapping", "preview", "result"] as Step[]).map((s, i) => (
            <span key={s} className={`flex items-center gap-1 ${step === s ? "text-primary font-medium" : ""}`}>
              {i > 0 && <ArrowRight className="h-3 w-3" />}
              <span className={`rounded-full w-5 h-5 flex items-center justify-center text-xs ${step === s ? "bg-primary text-primary-foreground" : "bg-muted"}`}>{i + 1}</span>
              {s === "upload" ? "Upload" : s === "mapping" ? "Map Columns" : s === "preview" ? "Preview" : "Done"}
            </span>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {step === "upload" && (
            <div className="flex flex-col items-center justify-center py-10 space-y-4" data-testid="csv-upload-step">
              <div className="w-16 h-16 rounded-lg bg-primary/10 flex items-center justify-center">
                <Upload className="h-7 w-7 text-primary" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium">Upload your bank CSV file</p>
                <p className="text-xs text-muted-foreground mt-1">Download your transaction history from your bank&apos;s website as a CSV file</p>
              </div>
              {isUploading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Parsing CSV...
                </div>
              ) : (
                <label className="cursor-pointer inline-flex items-center gap-2 rounded-md px-4 py-2 bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors" data-testid="button-select-csv">
                  <Upload className="h-4 w-4" />
                  Select CSV File
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleFileSelect(f);
                    }}
                    data-testid="input-csv-file"
                  />
                </label>
              )}
            </div>
          )}

          {step === "mapping" && csvData && (
            <div className="space-y-4" data-testid="csv-mapping-step">
              <div className="rounded-lg border border-border/50 bg-muted/30 p-3">
                <p className="text-xs text-muted-foreground mb-1">File: <span className="font-medium text-foreground">{file?.name}</span></p>
                <p className="text-xs text-muted-foreground">{csvData.rowCount} transactions found &middot; {csvData.headers.length} columns detected</p>
              </div>

              <div className="space-y-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Column Mapping</p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">Date Column</label>
                    <select value={dateCol} onChange={e => setDateCol(parseInt(e.target.value))}
                      className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-xs"
                      data-testid="select-date-column">
                      {csvData.headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">Description Column</label>
                    <select value={descCol} onChange={e => setDescCol(parseInt(e.target.value))}
                      className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-xs"
                      data-testid="select-description-column">
                      {csvData.headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="flex items-center gap-2 text-xs cursor-pointer mb-2">
                    <input type="checkbox" checked={useDebitCredit} onChange={e => setUseDebitCredit(e.target.checked)}
                      className="rounded" data-testid="checkbox-debit-credit" />
                    <span>Separate debit/credit columns</span>
                  </label>
                  {useDebitCredit ? (
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs text-muted-foreground block mb-1">Debit Column</label>
                        <select value={debitCol} onChange={e => setDebitCol(parseInt(e.target.value))}
                          className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-xs"
                          data-testid="select-debit-column">
                          {csvData.headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground block mb-1">Credit Column</label>
                        <select value={creditCol} onChange={e => setCreditCol(parseInt(e.target.value))}
                          className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-xs"
                          data-testid="select-credit-column">
                          {csvData.headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
                        </select>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <label className="text-xs text-muted-foreground block mb-1">Amount Column</label>
                      <select value={amountCol} onChange={e => setAmountCol(parseInt(e.target.value))}
                        className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-xs"
                        data-testid="select-amount-column">
                        {csvData.headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
                      </select>
                    </div>
                  )}
                </div>

                <div>
                  <label className="text-xs text-muted-foreground block mb-1">Import Into Account</label>
                  <select value={accountId} onChange={e => setAccountId(e.target.value)}
                    className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-xs"
                    data-testid="select-account">
                    {allAccounts.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
                  </select>
                  {accountId === "manual-import" && (
                    <input
                      type="text"
                      value={customAccountName}
                      onChange={e => setCustomAccountName(e.target.value)}
                      placeholder="Account name (e.g., Chase Checking)"
                      className="w-full mt-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs"
                      data-testid="input-custom-account-name"
                    />
                  )}
                </div>
              </div>

              {csvData.sampleRows.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Raw Data Preview</p>
                  <div className="overflow-x-auto rounded-md border border-border/50">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border/50 bg-muted/50">
                          {csvData.headers.map((h, i) => (
                            <th key={i} className="px-2 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {csvData.sampleRows.slice(0, 3).map((row, ri) => (
                          <tr key={ri} className="border-b border-border/30">
                            {row.map((cell, ci) => (
                              <td key={ci} className="px-2 py-1 whitespace-nowrap max-w-[200px] truncate">{cell}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {step === "preview" && (
            <div className="space-y-4" data-testid="csv-preview-step">
              <div className="rounded-lg border border-border/50 bg-muted/30 p-3">
                <p className="text-xs text-muted-foreground">Showing up to 10 parsed transactions. Verify the data looks correct before importing.</p>
              </div>

              {previewRows.length > 0 ? (
                <div className="overflow-x-auto rounded-md border border-border/50">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border/50 bg-muted/50">
                        <th className="px-3 py-1.5 text-left font-medium text-muted-foreground">Date</th>
                        <th className="px-3 py-1.5 text-left font-medium text-muted-foreground">Description</th>
                        <th className="px-3 py-1.5 text-right font-medium text-muted-foreground">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {previewRows.map((row, i) => (
                        <tr key={i} className="border-b border-border/30">
                          <td className="px-3 py-1.5 whitespace-nowrap">{row.date}</td>
                          <td className="px-3 py-1.5 max-w-[300px] truncate">{row.description}</td>
                          <td className={`px-3 py-1.5 text-right whitespace-nowrap ${row.amount < 0 ? "text-success" : ""}`}>
                            {formatCurrency(row.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="flex flex-col items-center py-8 text-center">
                  <AlertCircle className="h-8 w-8 text-muted-foreground mb-2" />
                  <p className="text-sm text-muted-foreground">No valid transactions could be parsed. Check your column mapping.</p>
                </div>
              )}

              <p className="text-xs text-muted-foreground">
                Total rows in file: <span className="font-medium text-foreground">{csvData?.rowCount || 0}</span>.
                Duplicates will be automatically skipped during import.
              </p>
            </div>
          )}

          {step === "result" && importResult && (
            <div className="flex flex-col items-center py-8 space-y-4" data-testid="csv-result-step">
              <div className="w-14 h-14 rounded-full bg-success/10 flex items-center justify-center">
                <Check className="h-6 w-6 text-success" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium">Import Complete</p>
                <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                  <span><span className="font-medium text-foreground">{importResult.imported}</span> imported</span>
                  <span><span className="font-medium text-foreground">{importResult.skipped}</span> skipped</span>
                </div>
              </div>
              {importResult.errors.length > 0 && (
                <div className="w-full rounded-lg border border-warning/30 bg-warning/5 p-3 max-h-32 overflow-y-auto">
                  <p className="text-xs font-medium text-warning-foreground mb-1">Warnings ({importResult.errors.length})</p>
                  {importResult.errors.slice(0, 10).map((e, i) => (
                    <p key={i} className="text-xs text-muted-foreground">{e}</p>
                  ))}
                  {importResult.errors.length > 10 && (
                    <p className="text-xs text-muted-foreground mt-1">...and {importResult.errors.length - 10} more</p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-border/50 flex items-center justify-between">
          <div>
            {step !== "upload" && step !== "result" && (
              <button
                onClick={() => setStep(step === "preview" ? "mapping" : "upload")}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                data-testid="button-csv-back">
                <ArrowLeft className="h-3 w-3" /> Back
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {step === "result" ? (
              <button onClick={handleClose}
                className="inline-flex items-center gap-1 rounded-md px-3 py-1.5 bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90"
                data-testid="button-csv-done">
                Done
              </button>
            ) : step === "mapping" ? (
              <button onClick={handlePreview} disabled={isUploading}
                className="inline-flex items-center gap-1 rounded-md px-3 py-1.5 bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50"
                data-testid="button-csv-preview">
                {isUploading ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowRight className="h-3 w-3" />}
                Preview
              </button>
            ) : step === "preview" ? (
              <button
                onClick={() => importMutation.mutate()}
                disabled={importMutation.isPending || previewRows.length === 0}
                className="inline-flex items-center gap-1 rounded-md px-3 py-1.5 bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50"
                data-testid="button-csv-import">
                {importMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                Import {csvData?.rowCount || 0} Transactions
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
