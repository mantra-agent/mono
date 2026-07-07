import { useMutation, type UseMutationOptions } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

type HttpMethod = "POST" | "PATCH" | "PUT" | "DELETE";

interface UseApiMutationOptions<TInput, TResult> {
  method: HttpMethod;
  path: string | ((input: TInput) => string);
  body?: (input: TInput) => Record<string, unknown> | null;
  invalidateKeys?: string[][];
  successMessage?: string | ((result: TResult, input: TInput) => string);
  errorTitle?: string;
  onSuccess?: (result: TResult, input: TInput) => void;
  onError?: (err: Error) => void;
  onMutate?: UseMutationOptions<TResult, Error, TInput>["onMutate"];
  onSettled?: () => void;
  // Retry-once on a 409 from the server. Used by endpoints that surface
  // serialization/deadlock conflicts as 409 with a retryable hint (e.g.
  // PATCH /api/info/library/reorder). The default backoff is 250ms with a
  // small jitter so concurrent clients don't all retry on the same beat.
  retryOn409?: boolean;
}

function is409Error(err: unknown): boolean {
  if (!err || typeof (err as Error).message !== "string") return false;
  return /^409:/.test((err as Error).message);
}

export function useApiMutation<TInput = void, TResult = unknown>(opts: UseApiMutationOptions<TInput, TResult>) {
  const { toast } = useToast();

  return useMutation<TResult, Error, TInput>({
    mutationFn: async (input: TInput) => {
      const url = typeof opts.path === "function" ? opts.path(input) : opts.path;
      const bodyData = opts.body ? opts.body(input) : (input as Record<string, unknown>);
      const doRequest = async () => {
        const res = await apiRequest(opts.method, url, opts.method === "DELETE" ? undefined : bodyData);
        return res.json() as Promise<TResult>;
      };
      try {
        return await doRequest();
      } catch (err) {
        if (opts.retryOn409 && is409Error(err)) {
          // 250ms ± 100ms jitter — short enough to feel instant, long enough
          // for the contending writer to commit its xact and release the
          // advisory lock.
          await new Promise((r) => setTimeout(r, 250 + Math.floor(Math.random() * 100)));
          return await doRequest();
        }
        throw err;
      }
    },
    onMutate: opts.onMutate,
    onSuccess: (result, input) => {
      if (opts.invalidateKeys) {
        for (const key of opts.invalidateKeys) {
          queryClient.invalidateQueries({ queryKey: key });
        }
      }
      if (opts.successMessage) {
        const title = typeof opts.successMessage === "function"
          ? opts.successMessage(result, input)
          : opts.successMessage;
        toast({ title });
      }
      opts.onSuccess?.(result, input);
    },
    onError: (err: Error) => {
      if (opts.onError) {
        opts.onError(err);
      } else {
        toast({
          title: opts.errorTitle || "Operation failed",
          description: err.message,
          variant: "destructive",
        });
      }
    },
    onSettled: opts.onSettled,
  });
}
