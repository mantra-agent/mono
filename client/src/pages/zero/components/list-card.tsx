import type { ListCardProps } from "@shared/models/glasses";

export function ListCard({ title, items, maxVisible }: ListCardProps) {
  const visibleItems = maxVisible ? items.slice(0, maxVisible) : items;

  return (
    <div className="glasses-card focusable">
      <h3 className="glasses-title" style={{ marginBottom: 12 }}>
        {title}
      </h3>
      <div>
        {visibleItems.map((item, i) => (
          <div key={i} className="glasses-list-item">
            <span className="glasses-list-label">{item.label}</span>
            {item.meta && <span className="glasses-list-meta">{item.meta}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
