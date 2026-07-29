import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";
import { usePageHeader } from "@/hooks/use-page-header";

export default function DebugToastPage() {
  usePageHeader({ title: "Toast" });

  return (
    <div className="flex h-full w-full items-start p-6" data-testid="debug-toast-page">
      <Button
        type="button"
        onClick={() => {
          toast({
            title: "Test toast",
            description: "Toast system is working.",
            relayToGlasses: false,
          });
        }}
      >
        Show test toast
      </Button>
    </div>
  );
}
