export function setupSftpResize(panel, onSave) {
  const handle = document.createElement('div');
  handle.id = 'sftp-resizer'; handle.tabIndex = 0; handle.role = 'separator';
  handle.setAttribute('aria-label','调整 SFTP 宽度');
  handle.setAttribute('aria-orientation','vertical');
  handle.setAttribute('aria-controls','files');
  handle.title = '左右拖动调整宽度 · 双击恢复默认';
  panel.append(handle);
  let preferred = 440, drag = null;
  const maximum = () => Math.max(300,Math.min(1200,panel.parentElement.clientWidth-320-(document.getElementById('snippets')?.getBoundingClientRect().width || 0)));
  const clamp = value => Math.round(Math.max(300,Math.min(maximum(),value)));
  function render() {
    const width = clamp(preferred);
    panel.style.width = width+'px';
    handle.setAttribute('aria-valuemin','300');
    handle.setAttribute('aria-valuemax',String(maximum()));
    handle.setAttribute('aria-valuenow',String(width));
  }
  function finish(e) {
    if (!drag || e && e.pointerId !== drag.id) return;
    const id = drag.id; drag = null;
    document.body.classList.remove('sftp-resizing');
    if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
    onSave();
  }
  handle.onpointerdown = e => {
    if (e.button !== 0 || drag) return;
    e.preventDefault(); handle.focus();
    drag = {id:e.pointerId,x:e.clientX,width:panel.getBoundingClientRect().width};
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('sftp-resizing');
  };
  handle.onpointermove = e => {
    if (drag?.id !== e.pointerId) return;
    preferred = clamp(drag.width+e.clientX-drag.x); render();
  };
  handle.onpointerup = handle.onpointercancel = handle.onlostpointercapture = finish;
  window.addEventListener('blur',() => finish());
  handle.ondblclick = () => { preferred = 440; render(); onSave(); };
  handle.onkeydown = e => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
    e.preventDefault();
    const width = panel.getBoundingClientRect().width;
    preferred = clamp(e.key === 'Home' ? 300 : e.key === 'End' ? maximum() : width+(e.key === 'ArrowLeft' ? -1 : 1)*(e.shiftKey ? 40 : 10));
    render(); onSave();
  };
  new ResizeObserver(render).observe(panel.parentElement);
  new MutationObserver(render).observe(panel.parentElement,{subtree:true,attributes:true,attributeFilter:['hidden']});
  return {
    get width() { return preferred; },
    load(value) { preferred = Number.isFinite(value) ? Math.max(300,Math.min(1200,value)) : 440; render(); }
  };
}
