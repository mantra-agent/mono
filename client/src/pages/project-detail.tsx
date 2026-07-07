import { useState } from "react";
import { useLocation, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ProjectDetail, TaskDetails } from "./work";
import { useFocusContext } from "@/hooks/use-focus-context";
import { usePageHeader } from "@/hooks/use-page-header";

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const projectId = Number(id);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);

  const { data: project } = useQuery<{ id: number; name?: string; title?: string }>({
    queryKey: ["/api/projects", projectId],
    enabled: !!id && !isNaN(projectId),
  });

  useFocusContext(
    selectedTaskId !== null
      ? { entity: { type: "task", id: String(selectedTaskId) } }
      : !!id && !isNaN(projectId)
        ? { entity: { type: "project", id: String(projectId), label: project?.name || project?.title } }
        : null
  );
  usePageHeader({ title: project?.name || project?.title || "Project" });

  if (!id || isNaN(projectId)) {
    setLocation("/projects");
    return null;
  }

  if (selectedTaskId !== null) {
    return (
      <div className="flex flex-col h-full overflow-y-auto overflow-x-hidden" data-testid="project-task-detail">
        <TaskDetails taskId={selectedTaskId} onBack={() => setSelectedTaskId(null)} />
      </div>
    );
  }

  return (
    <div className="p-4" data-testid="project-detail-page">
      <ProjectDetail
        projectId={projectId}
        onBack={() => setLocation("/projects")}
        onOpenTask={(taskId) => setSelectedTaskId(taskId)}
      />
    </div>
  );
}
