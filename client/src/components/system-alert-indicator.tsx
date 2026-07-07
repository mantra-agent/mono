import { useSkillFailures } from "./skill-failure-indicator";
import { useLogErrors } from "@/hooks/use-log-errors";


export function useSystemActivity(): boolean {
  const { hasUnseenFailures } = useSkillFailures();
  const { hasUnseenErrors } = useLogErrors();
  return hasUnseenFailures || hasUnseenErrors;
}

