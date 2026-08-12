import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Circle, Loader2, Plus, Trash2, Wrench } from "lucide-react";
import { usePageHeader } from "@/hooks/use-page-header";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface Product { id: number; name: string; featureRequestCount: number }
interface FeatureRequest { id: number; title: string; description: string; status: "backlog" | "planned" | "completed"; createdAt: string }
interface Backlog { requests: FeatureRequest[] }

export default function BacklogPage() {
  usePageHeader({ title: "Backlog" });
  const queryClient = useQueryClient();
  const [location, setLocation] = useLocation();
  const params = new URLSearchParams(location.split("?")[1] ?? "");
  const [productId, setProductId] = useState(params.get("product") ?? "");
  const [status, setStatus] = useState(params.get("status") ?? "all");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const { data: products = [], isLoading } = useQuery<Product[]>({ queryKey: ["/api/products"] });
  const selected = productId || (products[0]?.id ? String(products[0].id) : "");
  const { data } = useQuery<Backlog>({ queryKey: ["/api/products", selected, "backlog"], queryFn: async () => (await apiRequest("GET", `/api/products/${selected}/backlog`)).json(), enabled: !!selected });
  useEffect(() => { if (selected && selected !== productId) setProductId(selected); }, [selected, productId]);
  const persist = (nextProduct = selected, nextStatus = status) => setLocation(`/backlog?product=${nextProduct}&status=${nextStatus}`);
  const requests = useMemo(() => (data?.requests ?? []).filter((request) => status === "all" || request.status === status), [data, status]);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["/api/products", selected, "backlog"] });
  const create = useMutation({ mutationFn: async () => apiRequest("POST", `/api/products/${selected}/backlog/feature-requests`, { title, description }), onSuccess: () => { setTitle(""); setDescription(""); refresh(); } });
  const update = useMutation({ mutationFn: async ({ id, patch }: { id: number; patch: Partial<FeatureRequest> }) => apiRequest("PATCH", `/api/products/${selected}/backlog/feature-requests/${id}`, patch), onSuccess: refresh });
  const remove = useMutation({ mutationFn: async (id: number) => apiRequest("DELETE", `/api/products/${selected}/backlog/feature-requests/${id}`, { confirm: true }), onSuccess: refresh });
  const bridge = useMutation({ mutationFn: async (id: number) => apiRequest("POST", `/api/products/${selected}/backlog/feature-requests/${id}/issue`, {}), onSuccess: refresh });
  if (isLoading) return <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  return <div className="h-full overflow-auto p-4"><div className="w-full">
    <div className="flex flex-wrap gap-2 border-b border-border/20 pb-4"><Select value={selected} onValueChange={(value) => { setProductId(value); persist(value); }}><SelectTrigger className="w-56"><SelectValue placeholder="Select Product" /></SelectTrigger><SelectContent>{products.map((product) => <SelectItem key={product.id} value={String(product.id)}>{product.name} ({product.featureRequestCount})</SelectItem>)}</SelectContent></Select><Select value={status} onValueChange={(value) => { setStatus(value); persist(selected, value); }}><SelectTrigger className="w-40"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All statuses</SelectItem><SelectItem value="backlog">Backlog</SelectItem><SelectItem value="planned">Planned</SelectItem><SelectItem value="completed">Completed</SelectItem></SelectContent></Select></div>
    <div className="flex flex-col gap-2 py-4 md:flex-row"><Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Feature Request title" /><Input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Description (optional)" /><Button className="bg-cta text-cta-foreground" disabled={!selected || !title.trim() || create.isPending} onClick={() => create.mutate()}><Plus className="mr-2 h-3.5 w-3.5" />New Request</Button></div>
    <div className="border-t border-border/20">{requests.length ? requests.map((request) => <div key={request.id} className="flex min-h-11 flex-wrap items-center gap-2 border-b border-border/20 px-2 py-2"><Circle className="h-3.5 w-3.5 text-muted-foreground" /><div className="min-w-48 flex-1"><Input defaultValue={request.title} className="border-0 px-0 text-sm" onBlur={(event) => event.target.value !== request.title && update.mutate({ id: request.id, patch: { title: event.target.value } })} /><div className="text-xs text-muted-foreground">{request.description || "No description"}</div></div><Select value={request.status} onValueChange={(value) => update.mutate({ id: request.id, patch: { status: value as FeatureRequest["status"] } })}><SelectTrigger className="w-32"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="backlog">Backlog</SelectItem><SelectItem value="planned">Planned</SelectItem><SelectItem value="completed">Completed</SelectItem></SelectContent></Select><Button variant="ghost" size="icon" title="Create Issue" onClick={() => bridge.mutate(request.id)}><Wrench className="h-4 w-4" /></Button><Button variant="ghost" size="icon" title="Delete Feature Request" onClick={() => window.confirm("Delete this Feature Request?") && remove.mutate(request.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button></div>) : <div className="px-2 py-1.5 text-sm text-muted-foreground">No Feature Requests yet.</div>}</div>
  </div></div>;
}
