import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Circle, Loader2, Plus } from "lucide-react";
import { usePageHeader } from "@/hooks/use-page-header";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface Product { id: number; name: string }
interface FeatureRequest { id: number; title: string; description: string; status: "backlog" | "planned" | "completed"; createdAt: string }
interface Backlog { requests: FeatureRequest[] }

export default function BacklogPage() {
  usePageHeader({ title: "Backlog" });
  const queryClient = useQueryClient();
  const [productId, setProductId] = useState("");
  const [title, setTitle] = useState("");
  const { data: products = [], isLoading } = useQuery<Product[]>({ queryKey: ["/api/products"] });
  const selected = productId || (products[0]?.id ? String(products[0].id) : "");
  const { data } = useQuery<Backlog>({ queryKey: ["/api/products", selected, "backlog"], queryFn: async () => (await apiRequest("GET", `/api/products/${selected}/backlog`)).json(), enabled: !!selected });
  const create = useMutation({ mutationFn: async () => apiRequest("POST", `/api/products/${selected}/backlog/feature-requests`, { title }), onSuccess: () => { setTitle(""); queryClient.invalidateQueries({ queryKey: ["/api/products", selected, "backlog"] }); } });
  if (isLoading) return <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  return <div className="h-full overflow-auto p-4"><div className="w-full md:w-1/3"><Select value={selected} onValueChange={setProductId}><SelectTrigger><SelectValue placeholder="Select Product" /></SelectTrigger><SelectContent>{products.map((product) => <SelectItem key={product.id} value={String(product.id)}>{product.name}</SelectItem>)}</SelectContent></Select><div className="flex gap-2 py-4"><Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Feature Request" onKeyDown={(event) => { if (event.key === "Enter" && title.trim()) create.mutate(); }} /><Button className="bg-cta text-cta-foreground" disabled={!selected || !title.trim()} onClick={() => create.mutate()}><Plus className="mr-2 h-3.5 w-3.5" />New Request</Button></div><div className="border-t border-border/20">{data?.requests.length ? data.requests.map((request) => <div key={request.id} className="flex min-h-11 items-center gap-2 border-b border-border/20 px-2"><Circle className="h-3.5 w-3.5 text-muted-foreground" /><span className="min-w-0 flex-1 truncate text-sm">{request.title}</span><span className="text-xs text-muted-foreground">{request.status}</span></div>) : <div className="px-2 py-1.5 text-sm text-muted-foreground">No Feature Requests yet.</div>}</div></div></div>;
}
