interface EmptyStateProps {
  message: string;
  testId?: string;
}

/** Quiet left-aligned zero-state row. Search/create stay outside this surface. */
export function EmptyState({ message, testId }: EmptyStateProps) {
  return (
    <div className="px-2 py-1.5 text-sm text-muted-foreground" data-testid={testId}>
      {message}
    </div>
  );
}
