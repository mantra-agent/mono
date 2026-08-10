import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2, Plus } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { HIERARCHY_PRIMARY_ACTION_CLASS } from "@/components/hierarchy-section-header";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  BUSINESS_QUERY_KEY,
  type BusinessDefinition,
} from "@/hooks/use-selected-business";

// The Business selector is the entry point for the whole /business surface:
// pick a Business, then read its Definition / Plan / Metrics. It reuses the
// shared query key so a create here immediately refreshes every consumer.
export function BusinessSelector({
  businesses,
  selectedId,
  onSelect,
}: {
  businesses: BusinessDefinition[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Select value={selectedId ?? undefined} onValueChange={onSelect}>
        <SelectTrigger className="w-64" data-testid="business-selector">
          <SelectValue placeholder="Select a Business" />
        </SelectTrigger>
        <SelectContent>
          {businesses.map((business) => (
            <SelectItem key={business.id} value={business.id}>
              {business.publicName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <CreateBusinessDialog onCreated={onSelect} />
    </div>
  );
}

function CreateBusinessDialog({ onCreated }: { onCreated: (id: string) => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [publicName, setPublicName] = useState("");
  const [entityName, setEntityName] = useState("");

  const mutation = useMutation<BusinessDefinition, Error, void>({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/business/definition", {
        publicName: publicName.trim(),
        entityName: entityName.trim() || undefined,
      });
      return res.json();
    },
    onSuccess: (business) => {
      queryClient.invalidateQueries({ queryKey: BUSINESS_QUERY_KEY });
      toast({ title: "Business created", description: business.publicName });
      onCreated(business.id);
      setOpen(false);
      setPublicName("");
      setEntityName("");
    },
    onError: (error: unknown) => {
      toast({
        title: "Failed to create Business",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button" className={HIERARCHY_PRIMARY_ACTION_CLASS} data-testid="create-business">
          <Plus className="h-3.5 w-3.5 shrink-0" />
          <span>New Business</span>
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Business</DialogTitle>
          <DialogDescription>A Business owns its Definition, Plan, KPIs, and Metrics.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            placeholder="Public name (e.g. TIVE)"
            value={publicName}
            onChange={(e) => setPublicName(e.target.value)}
            data-testid="business-public-name"
          />
          <Input
            placeholder="Legal entity name (optional)"
            value={entityName}
            onChange={(e) => setEntityName(e.target.value)}
            data-testid="business-entity-name"
          />
        </div>
        <DialogFooter>
          <Button
            onClick={() => mutation.mutate()}
            disabled={publicName.trim() === "" || mutation.isPending}
            data-testid="business-submit"
          >
            {mutation.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
