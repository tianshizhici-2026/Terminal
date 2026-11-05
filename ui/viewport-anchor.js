// Anchor the logical line, not the pixel offset, while font metrics and wrapping change.
const pending=new WeakMap();
export function preserveViewport(term, change) {
  if(pending.has(term)){change();return;}
  const buffer=term.buffer.active;
  if(buffer.type!=='normal'){change();return;}
  const bottom=buffer.viewportY===buffer.baseY;
  let row=buffer.viewportY;
  while(row>0 && buffer.getLine(row)?.isWrapped)row--;
  const marker=bottom?null:term.registerMarker(row-buffer.baseY-buffer.cursorY);
  const offset=(buffer.viewportY-row)*term.cols,oldLine=buffer.viewportY;
  pending.set(term,true);
  change();
  // xterm synchronizes its scrollbar after the renderer has updated cell metrics.
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    pending.delete(term);
    if(term.element?.isConnected && term.buffer.active===buffer){
      const target=bottom?buffer.baseY:marker && !marker.isDisposed ? marker.line+Math.floor(offset/term.cols) : oldLine;
      // xterm 6 scrollToLine applies a relative delta to its pixel viewport. Reset
      // that origin first: its old pixels may still refer to the previous font.
      term.scrollLines(-Number.MAX_SAFE_INTEGER);
      term.scrollToLine(target);
    }
    marker?.dispose();
  }));
}
