export function setupPanelResize(panel, onSave, {id, label, otherPanel, edge='right', defaultWidth=440, minWidth=300}) {
  const handle = document.createElement('div');
  handle.id = id; handle.className = 'panel-resizer'; handle.dataset.edge = edge; handle.tabIndex = 0; handle.role = 'separator';
  handle.setAttribute('aria-label',label);
  handle.setAttribute('aria-orientation','vertical');
  handle.setAttribute('aria-controls',panel.id);
  handle.title = '左右拖动调整宽度 · 双击恢复默认';
  panel.append(handle);
  let preferred = defaultWidth, drag = null, frame = null;
  const direction = edge === 'left' ? -1 : 1;
  const maximum = () => Math.max(minWidth,Math.min(1200,panel.parentElement.clientWidth-320-(otherPanel.getBoundingClientRect().width || 0)));
  const clamp = value => Math.round(Math.max(minWidth,Math.min(maximum(),value)));
  function render() {
    const width = clamp(preferred);
    panel.style.width = width+'px';
    handle.setAttribute('aria-valuemin',String(minWidth));
    handle.setAttribute('aria-valuemax',String(maximum()));
    handle.setAttribute('aria-valuenow',String(width));
  }
  function finish(e) {
    if (!drag || e && e.pointerId !== drag.id) return;
    const id = drag.id; drag = null;
    document.body.classList.remove('panel-resizing'); handle.classList.remove('resizing');
    if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
    onSave();
  }
  handle.onpointerdown = e => {
    if (e.button !== 0 || drag) return;
    e.preventDefault(); handle.focus();
    drag = {id:e.pointerId,x:e.clientX,width:panel.getBoundingClientRect().width};
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('panel-resizing'); handle.classList.add('resizing');
  };
  handle.onpointermove = e => {
    if (drag?.id !== e.pointerId) return;
    preferred = clamp(drag.width+direction*(e.clientX-drag.x)); render();
  };
  handle.onpointerup = handle.onpointercancel = handle.onlostpointercapture = finish;
  window.addEventListener('blur',() => finish());
  handle.ondblclick = () => { preferred = defaultWidth; render(); onSave(); };
  handle.onkeydown = e => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
    e.preventDefault();
    const width = panel.getBoundingClientRect().width;
    preferred = clamp(e.key === 'Home' ? minWidth : e.key === 'End' ? maximum() : width+direction*(e.key === 'ArrowLeft' ? -1 : 1)*(e.shiftKey ? 40 : 10));
    render(); onSave();
  };
  const schedule = () => { if(frame===null)frame=requestAnimationFrame(()=>{frame=null;render();}); };
  const observer = new ResizeObserver(schedule); observer.observe(panel.parentElement); observer.observe(otherPanel);
  new MutationObserver(schedule).observe(panel.parentElement,{subtree:true,attributes:true,attributeFilter:['hidden']});
  return {
    get width() { return preferred; },
    load(value) { preferred = Number.isFinite(value) ? Math.max(minWidth,Math.min(1200,value)) : defaultWidth; render(); }
  };
}
