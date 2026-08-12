import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Boxes, Loader2, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { usePageHeader } from "@/hooks/use-page-header";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

interface Product { id: number; name: string; description: string; status: "active" | "paused" | "archived"; backlogId: number; platforms: { platformId: number; platformName: string }[] }

export default function ProductsPage() {
  usePageHeader({ title: "Products" });
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [pending, setPending] = useState<{ product: Product; action: "archive" | "delete" } | null>(null);
  const { data = [], isLoading } = useQuery<Product[]>({ queryKey: ["/api/products"] });
  const create = useMutation({ mutationFn: async () => (await apiRequest("POST", "/api/products", { name })).json(), onSuccess: () => { setName(""); queryClient.invalidateQueries({ queryKey: ["/api/products"] }); } });
  const confirm = useMutation({ mutationFn: async () => pending?.action === "archive" ? apiRequest("POST", `/api/products/${pending.product.id}/archive`, { confirm: true }) : apiRequest("DELETE", `/api/products/${pending!.product.id}`, { confirm: true }), onSuccess: () => { setPending(null); queryClient.invalidateQueries({ queryKey: ["/api/products"] }); } });
  if (isLoading) return <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  return <div className="h-full overflow-auto p-4"><div className="w-full md:w-1/3">
    <div className="flex gap-2 pb-4"><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Product name" onKeyDown={(event) => { if (event.key === "Enter" && name.trim()) create.mutate(); }} /><Button className="bg-cta text-cta-foreground" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}><Plus className="mr-2 h-3.5 w-3.5" />New Product</Button></div>
    <div className="border-t border-border/20">{data.length ? data.map((product) => <div key={product.id} className="border-b border-border/20"><div className="flex min-h-11 items-center gap-2 px-2"><Boxes className="h-3.5 w-3.5 text-muted-foreground" /><span className="min-w-0 flex-1 truncate text-sm font-medium">{product.name}</span><span className="text-xs text-muted-foreground">{product.status}</span><DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={`Actions for ${product.name}`}><MoreHorizontal className="h-3.5 w-3.5" /></Button></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem onSelect={() => setPending({ product, action: "archive" })}><Archive className="mr-2 h-3.5 w-3.5" />Archive</DropdownMenuItem><DropdownMenuItem className="text-destructive" onSelect={() => setPending({ product, action: "delete" })}><Trash2 className="mr-2 h-3.5 w-3.5" />Delete</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div><div className="ml-6 border-l border-border/20 px-3 pb-2 text-sm text-muted-foreground">{product.description || "No description"}<div>{product.platforms.map((platform) => platform.platformName).join(", ") || "No Platforms"}</div></div></div>) : <div className="px-2 py-1.5 text-sm text-muted-foreground">No Products yet.</div>}</div>
  </div><AlertDialog open={!!pending} onOpenChange={(open) => !open && setPending(null)}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{pending?.action === "delete" ? "Delete Product" : "Archive Product"}</AlertDialogTitle><AlertDialogDescription>{pending?.action === "delete" ? "Deletion fails while Platforms, Feature Requests, Issues, or Design dependencies remain." : "Archive this Product? Its history remains available."}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => confirm.mutate()}>{pending?.action === "delete" ? "Delete" : "Archive"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></div>;
}
