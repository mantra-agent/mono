import { Redirect, useRoute } from "wouter";

export default function GoalDetailRedirect() {
  const [, params] = useRoute("/goals/:id");
  return <Redirect to={`/goals?goal=${encodeURIComponent(params?.id || "")}`} />;
}
