import type { TransitionCardProps } from "@shared/models/glasses";

export function TransitionCard({ message }: TransitionCardProps) {
  return (
    <div className="glasses-card glasses-transition">
      <p className="glasses-transition-message">{message}</p>
    </div>
  );
}
