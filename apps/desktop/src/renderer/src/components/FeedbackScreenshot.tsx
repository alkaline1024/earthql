import { useRef, useState, type PointerEvent } from 'react';

type Mode = 'crop' | 'cover';
type Point = { x: number; y: number };

function selection(start: Point, end: Point) {
  return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), w: Math.abs(end.x - start.x), h: Math.abs(end.y - start.y) };
}

export function FeedbackScreenshot({ image, onEdit, onReset, disabled }: {
  image: string;
  onEdit: (image: string) => void;
  onReset?: () => void;
  disabled: boolean;
}) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [region, setRegion] = useState<ReturnType<typeof selection> | null>(null);
  const [failed, setFailed] = useState(false);
  const gesture = useRef<{ start: Point; pointer: number } | null>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  function point(e: PointerEvent<HTMLDivElement>): Point {
    const box = e.currentTarget.getBoundingClientRect();
    const clamp = (n: number) => Math.max(0, Math.min(1, n));
    return { x: clamp((e.clientX - box.left) / box.width), y: clamp((e.clientY - box.top) / box.height) };
  }

  function begin(e: PointerEvent<HTMLDivElement>) {
    if (!mode || disabled || e.button !== 0 || gesture.current || !imageRef.current?.naturalWidth) return;
    const start = point(e);
    gesture.current = { start, pointer: e.pointerId };
    setRegion(selection(start, start));
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function move(e: PointerEvent<HTMLDivElement>) {
    const current = gesture.current;
    if (current?.pointer === e.pointerId) setRegion(selection(current.start, point(e)));
  }

  function clearGesture() {
    gesture.current = null;
    setRegion(null);
  }

  function finish(e: PointerEvent<HTMLDivElement>) {
    const current = gesture.current;
    if (!current || current.pointer !== e.pointerId) return;
    clearGesture();
    const source = imageRef.current;
    if (!source || !mode || disabled) return;
    const rect = selection(current.start, point(e));
    const width = source.naturalWidth;
    const height = source.naturalHeight;
    const x = Math.floor(rect.x * width);
    const y = Math.floor(rect.y * height);
    const w = Math.min(width, Math.ceil((rect.x + rect.w) * width)) - x;
    const h = Math.min(height, Math.ceil((rect.y + rect.h) * height)) - y;
    if (w < 3 || h < 3) return;
    const canvas = document.createElement('canvas');
    canvas.width = mode === 'crop' ? w : width;
    canvas.height = mode === 'crop' ? h : height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setFailed(true);
      return;
    }

    if (mode === 'crop') {
      ctx.drawImage(source, x, y, w, h, 0, 0, w, h);
    } else {
      ctx.drawImage(source, 0, 0);
      ctx.fillStyle = '#000';
      ctx.fillRect(x, y, w, h);
    }
    onEdit(canvas.toDataURL('image/jpeg', 0.85));
    setMode(null);
    setFailed(false);
  }

  return (
    <div className="col">
      <div className="row">
        <button className={`btn small${mode === 'crop' ? ' primary' : ''}`} disabled={disabled} aria-pressed={mode === 'crop'}
          onClick={() => setMode(mode === 'crop' ? null : 'crop')}>Crop</button>
        <button className={`btn small${mode === 'cover' ? ' primary' : ''}`} disabled={disabled} aria-pressed={mode === 'cover'}
          onClick={() => setMode(mode === 'cover' ? null : 'cover')}>Black out area</button>
        {onReset && <button className="btn small ghost" disabled={disabled} onClick={() => { setMode(null); setFailed(false); onReset(); }}>Reset edits</button>}
      </div>
      {mode && <span className="muted small">Drag over the area to {mode === 'crop' ? 'keep' : 'hide'}.</span>}
      <div className={`feedback-image${mode ? ' editing' : ''}`} onPointerDown={begin} onPointerMove={move}
        onPointerUp={finish} onPointerCancel={clearGesture} onLostPointerCapture={clearGesture}>
        <img ref={imageRef} src={image} alt="Screenshot to review before sending" draggable={false} />
        {region && <span className={`feedback-selection${mode === 'cover' ? ' cover' : ''}`} style={{
          left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.w * 100}%`, height: `${region.h * 100}%`,
        }} />}
      </div>
      {failed && <span role="alert">The image could not be edited. Remove the attachment before sending.</span>}
    </div>
  );
}
