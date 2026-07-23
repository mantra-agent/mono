import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Building2, Check, ChevronsUpDown, Loader2, Plus, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { apiRequest } from "@/lib/queryClient";

interface CompanyIndex {
  id: string;
  name: string;
  industry?: string | null;
}

// The Company field is a reference selector, not a text box. It commits a
// canonical `@company:id` reference (or empty string to clear). Selecting an
// existing company links by id; a human may explicitly create a new Company
// from the typed query. Free text is never persisted.
export function CompanyReferenceField({ value, onCommit }: { value: string; onCommit: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery<{ companies: CompanyIndex[] }>({ queryKey: ["/api/companies"] });
  const companies = data?.companies ?? [];

  const match = value.match(/^@company:([^\s]+)$/);
  const selectedId = match ? match[1] : null;
  const legacyText = !match && value.trim() ? value.trim() : "";
  const selected = selectedId ? companies.find(c => c.id === selectedId) : undefined;

  const query = search.trim().toLowerCase();
  const filtered = useMemo(
    () => (query ? companies.filter(c => c.name.toLowerCase().includes(query)) : companies),
    [companies, query],
  );
  const exactMatch = companies.some(c => c.name.trim().toLowerCase() === query);

  const createMutation = useMutation({
    mutationFn: async (name: string) => (await apiRequest("POST", "/api/companies", { name })).json(),
    onSuccess: (company: { id: string }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/companies"] });
      onCommit(`@company:${company.id}`);
      setOpen(false);
      setSearch("");
    },
  });

  const commit = (id: string) => { onCommit(`@company:${id}`); setOpen(false); setSearch(""); };
  const clear = () => { onCommit(""); setOpen(false); setSearch(""); };

  const label = selected?.name ?? legacyText;

  return (
    <Popover open={open} onOpenChange={next => { setOpen(next); if (!next) setSearch(""); }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="button-company-picker"
          className="flex h-5 w-48 items-center gap-1 overflow-hidden rounded-md border border-input bg-muted/50 px-1.5 text-xs leading-5"
        >
          {label ? (
            <span className={`flex min-w-0 flex-1 items-center gap-1 ${selected ? "text-cta" : "text-muted-foreground"}`}>
              <Building2 className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-left">{label}</span>
            </span>
          ) : (
            <span className="min-w-0 flex-1 truncate text-left text-muted-foreground">Select company</span>
          )}
          <ChevronsUpDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-0">
        <Command shouldFilter={false}>
          <CommandInput value={search} onValueChange={setSearch} placeholder="Search company…" className="h-9 text-xs" />
          <CommandList>
            {isLoading ? (
              <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
            ) : (
              <>
                <CommandEmpty>No companies found.</CommandEmpty>
                {(selectedId || legacyText) && (
                  <CommandGroup>
                    <CommandItem value="__clear__" onSelect={clear} className="text-xs text-muted-foreground">
                      <X className="mr-2 h-3.5 w-3.5" />Clear company
                    </CommandItem>
                  </CommandGroup>
                )}
                {filtered.length > 0 && (
                  <CommandGroup>
                    {filtered.map(c => (
                      <CommandItem key={c.id} value={c.id} onSelect={() => commit(c.id)} className="text-xs">
                        <Building2 className="mr-2 h-3.5 w-3.5 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{c.name}</span>
                        {c.id === selectedId && <Check className="ml-2 h-3.5 w-3.5" />}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                {query && !exactMatch && (
                  <CommandGroup>
                    <CommandItem
                      value="__create__"
                      onSelect={() => createMutation.mutate(search.trim())}
                      disabled={createMutation.isPending}
                      className="text-xs text-cta"
                    >
                      <Plus className="mr-2 h-3.5 w-3.5" />Create “{search.trim()}”
                    </CommandItem>
                  </CommandGroup>
                )}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
