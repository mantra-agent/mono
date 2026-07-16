import { Search, X } from "lucide-react";

interface HierarchySearchInputProps {
  value: string;
  onChange: (value: string) => void;
  inputTestId: string;
  clearTestId: string;
  ariaLabel: string;
}

export function HierarchySearchInput({
  value,
  onChange,
  inputTestId,
  clearTestId,
  ariaLabel,
}: HierarchySearchInputProps) {
  return (
    <div className="relative min-w-0 mb-1">
      <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={ariaLabel}
        className="w-full h-7 pl-7 pr-7 rounded-md border border-input bg-background text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        data-testid={inputTestId}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label={`Clear ${ariaLabel.toLowerCase()}`}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 h-4 w-4 flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
          data-testid={clearTestId}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
