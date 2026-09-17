import { useState } from "react";
import type { DragEvent } from "react";
import { DEFAULT_ROW_LAYOUT, ROW_FIELDS, ROW_FIELD_LABELS, ROW_FIELD_SAMPLES } from "../shared/row-layout";
import type { RowField, RowLayout } from "../shared/types";

function SampleField({ field }: { field: RowField }) {
  if (field === "trend") {
    return (
      <svg className="layout-sample-trend" viewBox="0 0 96 34" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0 17H96" stroke="var(--text-subtle)" strokeDasharray="4 4" fill="none" />
        <path d="M0 23 L8 15 L15 18 L23 5 L30 10 L38 12 L46 20 L54 16 L62 21 L70 15 L78 18 L87 12 L96 14" stroke="var(--up)" strokeWidth="1.6" fill="none" />
      </svg>
    );
  }
  return <span className={`layout-sample-value field-${field}`}>{ROW_FIELD_SAMPLES[field]}</span>;
}

export default function RowLayoutEditor({ layout, onChange }: { layout: RowLayout; onChange: (layout: RowLayout) => void }) {
  const [dragging, setDragging] = useState<RowField | null>(null);
  const [activeColumn, setActiveColumn] = useState<number | null>(null);
  const placed = new Set(layout.columns.flat());
  const available = ROW_FIELDS.filter((field) => !placed.has(field));

  const place = (field: RowField, columnIndex: number, targetIndex?: number) => {
    const columns = layout.columns.map((column) => [...column]);
    const oldColumn = columns.findIndex((column) => column.includes(field));
    const oldIndex = oldColumn < 0 ? -1 : columns[oldColumn].indexOf(field);
    if (oldColumn >= 0) columns[oldColumn].splice(oldIndex, 1);
    let insertIndex = targetIndex ?? columns[columnIndex].length;
    if (oldColumn === columnIndex && oldIndex < insertIndex) insertIndex -= 1;
    columns[columnIndex].splice(Math.max(0, insertIndex), 0, field);
    onChange({ columns });
    setDragging(null);
    setActiveColumn(null);
  };

  const remove = (field: RowField) => {
    if (placed.size <= 1) return;
    onChange({ columns: layout.columns.map((column) => column.filter((item) => item !== field)) });
    setDragging(null);
    setActiveColumn(null);
  };

  const startDrag = (event: DragEvent<HTMLElement>, field: RowField) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", field);
    setDragging(field);
  };

  const draggedField = (event: DragEvent<HTMLElement>): RowField | null => {
    const field = (dragging ?? event.dataTransfer.getData("text/plain")) as RowField;
    return ROW_FIELDS.includes(field) ? field : null;
  };

  const dropInto = (event: DragEvent<HTMLElement>, columnIndex: number, targetIndex?: number) => {
    event.preventDefault();
    event.stopPropagation();
    const field = draggedField(event);
    if (field) place(field, columnIndex, targetIndex);
  };

  const add = (field: RowField) => {
    const firstEmpty = layout.columns.findIndex((column) => column.length === 0);
    const columnIndex = firstEmpty >= 0 ? firstEmpty : layout.columns.reduce((best, column, index) =>
      column.length < layout.columns[best].length ? index : best, 0);
    place(field, columnIndex);
  };

  return (
    <section className="settings-card layout-builder">
      <div className="layout-builder-heading">
        <div>
          <h2>股票列表布局</h2>
          <p className="options-note">把下方的数据控件拖进这条股票行。模板内可继续拖动排序，点 × 可移回控件区。</p>
        </div>
        <button className="text-button" type="button" onClick={() => onChange({ columns: DEFAULT_ROW_LAYOUT.columns.map((column) => [...column]) })}>恢复默认</button>
      </div>

      <div className="layout-template-wrap">
        <div className="layout-template-caption">股票行模板 <span>区域从左到右排列，区域内从上到下排列；空区域在列表中收起</span></div>
        <div className="layout-template-row">
          {layout.columns.map((column, columnIndex) => (
            <div key={columnIndex} className={`layout-drop-zone ${activeColumn === columnIndex ? "active" : ""}`}
              onDragOver={(event) => { event.preventDefault(); setActiveColumn(columnIndex); }}
              onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setActiveColumn(null); }}
              onDrop={(event) => dropInto(event, columnIndex)}>
              {column.length === 0 && <span className="layout-empty-zone">拖到这里<br />区域 {columnIndex + 1}</span>}
              {column.map((field, fieldIndex) => (
                <div key={field} className={`layout-preview-field ${dragging === field ? "dragging" : ""}`}
                  draggable title={`拖动${ROW_FIELD_LABELS[field]}调整位置`}
                  onDragStart={(event) => startDrag(event, field)} onDragEnd={() => { setDragging(null); setActiveColumn(null); }}
                  onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); setActiveColumn(columnIndex); }}
                  onDrop={(event) => {
                    const bounds = event.currentTarget.getBoundingClientRect();
                    const after = event.clientY > bounds.top + bounds.height / 2;
                    dropInto(event, columnIndex, fieldIndex + (after ? 1 : 0));
                  }}>
                  <SampleField field={field} />
                  <button className="layout-remove-field" type="button" aria-label={`移除${ROW_FIELD_LABELS[field]}`}
                    disabled={placed.size <= 1} onClick={() => remove(field)}>×</button>
                </div>
              ))}
            </div>
          ))}
          <div className="layout-template-actions" aria-hidden="true">分组<br />移除</div>
        </div>
      </div>

      <div className="layout-palette-heading">
        <h3>可添加的数据控件</h3>
        <span>拖进上方模板，或点击 + 添加</span>
      </div>
      <div className="layout-field-palette"
        onDragOver={(event) => { if (dragging && placed.has(dragging)) event.preventDefault(); }}
        onDrop={(event) => { event.preventDefault(); const field = draggedField(event); if (field && placed.has(field)) remove(field); }}>
        {available.length === 0 && <p className="options-note">所有数据控件都已放入模板。可把模板中的控件拖回这里。</p>}
        {available.map((field) => (
          <div key={field} className="layout-palette-field" draggable
            onDragStart={(event) => startDrag(event, field)} onDragEnd={() => { setDragging(null); setActiveColumn(null); }}>
            <span className="layout-palette-grip" aria-hidden="true">⠿</span>
            <span className="layout-palette-label"><strong>{ROW_FIELD_LABELS[field]}</strong><small>{ROW_FIELD_SAMPLES[field] || "分时走势"}</small></span>
            <button type="button" aria-label={`添加${ROW_FIELD_LABELS[field]}`} onClick={() => add(field)}>＋</button>
          </div>
        ))}
      </div>
    </section>
  );
}
