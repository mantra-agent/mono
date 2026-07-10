import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { TaskWidget } from "@/components/task-widget";

interface TaskModalContextValue {
  openTaskModal: (taskId: number) => void;
  closeTaskModal: () => void;
}

const TaskModalContext = createContext<TaskModalContextValue | null>(null);

export function useTaskModal() {
  const ctx = useContext(TaskModalContext);
  if (!ctx) throw new Error("useTaskModal must be used within TaskModalProvider");
  return ctx;
}

export function TaskModalProvider({ children }: { children: ReactNode }) {
  const [openTaskId, setOpenTaskId] = useState<number | null>(null);

  const openTaskModal = useCallback((taskId: number) => {
    setOpenTaskId(taskId);
  }, []);

  const closeTaskModal = useCallback(() => {
    setOpenTaskId(null);
  }, []);

  return (
    <TaskModalContext.Provider value={{ openTaskModal, closeTaskModal }}>
      {children}
      <Dialog open={openTaskId !== null} onOpenChange={(open) => { if (!open) closeTaskModal(); }}>
        <DialogContent className="max-w-lg p-0 gap-0 overflow-y-auto max-h-[85vh]">
          <VisuallyHidden>
            <DialogTitle>Task Details</DialogTitle>
          </VisuallyHidden>
          {openTaskId !== null && (
            <TaskWidget
              taskId={openTaskId}
              defaultExpanded
              onDelete={closeTaskModal}
            />
          )}
        </DialogContent>
      </Dialog>
    </TaskModalContext.Provider>
  );
}
