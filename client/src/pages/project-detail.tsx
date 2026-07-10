import { useLocation, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ProjectDetail } from "./work";
import { useFocusContext } from "@/hooks/use-focus-context";
import { usePageHeader } from "@/hooks/use-page-header";

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const projectId = Number(id);

  const { data: project } = useQuery<{ id: number; name?: string; title?: string }>({
    queryKey: ["/api/projects", projectId],
    enabled: !!id && !isNaN(projectId),
  });

  useFocusContext(
    !!id && !isNaN(projectId)
      ? { entity: { type: "project", id: String(projectId), label: project?.name || project?.title } }
      : null
  );
  usePageHeader({ title: project?.name || project?.title || "Project" });

  if (!id || isNaN(projectId)) {
    setLocation("/projects");
    return null;
  }

  return (
    <div className="p-4" data-testid="project-detail-page">
      <ProjectDetail
        projectId={projectId}
        onBack={() => setLocation("/projects")}
      />
    </div>
  );
}
