import { useCallback, useEffect, useRef, useState } from 'react';

export interface VirtualTableColumn<T> {
  key: string;
  header: string;
  width: string;
  className?: string;
  render: (item: T) => React.ReactNode;
}

interface VirtualTableProps<T> {
  items: T[];
  columns: Array<VirtualTableColumn<T>>;
  rowHeight?: number;
  selectedId?: string | null;
  getId: (item: T) => string;
  getRowClass?: (item: T) => string;
  onSelect?: (item: T) => void;
  emptyTitle: string;
  emptyHint?: string;
}

const OVERSCAN = 12;

/**
 * Windowed table.
 *
 * A busy single-page app easily produces thousands of requests in a session;
 * rendering them all would make the panel unusable. Only the visible slice is
 * mounted, so scrolling stays smooth regardless of session size.
 */
export function VirtualTable<T>({
  items,
  columns,
  rowHeight = 26,
  selectedId,
  getId,
  getRowClass,
  onSelect,
  emptyTitle,
  emptyHint,
}: VirtualTableProps<T>): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(400);

  const measure = useCallback(() => {
    if (containerRef.current) setViewportHeight(containerRef.current.clientHeight);
  }, []);

  useEffect(() => {
    measure();
    const observer = new ResizeObserver(measure);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [measure]);

  const total = items.length;
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / rowHeight) + OVERSCAN * 2;
  const last = Math.min(total, first + visibleCount);
  const slice = items.slice(first, last);

  return (
    <div className="vtable" ref={containerRef} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
      <div className="vtable-head">
        {columns.map((column) => (
          <div key={column.key} style={{ flex: `0 0 ${column.width}` }} className={column.className}>
            {column.header}
          </div>
        ))}
      </div>

      {total === 0 ? (
        <div className="empty">
          <strong>{emptyTitle}</strong>
          {emptyHint ? <span>{emptyHint}</span> : null}
        </div>
      ) : (
        <div className="vtable-body" style={{ height: total * rowHeight }}>
          {slice.map((item, index) => {
            const id = getId(item);
            return (
              <div
                key={id}
                className={`vrow ${getRowClass?.(item) ?? ''} ${selectedId === id ? 'selected' : ''}`}
                style={{ top: (first + index) * rowHeight, height: rowHeight }}
                onClick={() => onSelect?.(item)}
                role="row"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') onSelect?.(item);
                }}
              >
                {columns.map((column) => (
                  <div key={column.key} className={`cell ${column.className ?? ''}`} style={{ flex: `0 0 ${column.width}` }}>
                    {column.render(item)}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
