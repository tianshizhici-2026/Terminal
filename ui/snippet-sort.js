export function setupSnippetSort(list,{commit,restore}) {
  let gesture=null, suppressClick=false, saving=false;
  function position(){
    if(!gesture?.active)return;
    const {row,y}=gesture;
    const before=[...list.children].find(other=>other!==row && y<other.getBoundingClientRect().top+other.getBoundingClientRect().height/2);
    list.insertBefore(row,before||null);
  }
  function scroll(){
    if(!gesture?.active)return;
    const bounds=list.getBoundingClientRect();
    const delta=gesture.y<bounds.top+30?-7:gesture.y>bounds.bottom-30?7:0;
    if(delta){list.scrollTop+=delta;position();}
    gesture.frame=requestAnimationFrame(scroll);
  }
  function finish(cancel=false){
    const g=gesture;if(!g)return;gesture=null;clearTimeout(g.timer);cancelAnimationFrame(g.frame);
    if(list.hasPointerCapture(g.id))list.releasePointerCapture(g.id);
    g.row.classList.remove('sorting');
    if(!g.active)return;
    suppressClick=true;
    if(cancel){restore();return;}
    saving=true;Promise.resolve(commit([...list.children].map(row=>row.dataset.snippet))).finally(()=>{saving=false;});
  }
  list.addEventListener('pointerdown',e=>{
    suppressClick=false;
    if(saving||e.button!==0||!e.isPrimary||e.target.closest('.snippet-actions'))return;
    const row=e.target.closest('.snippet-row');if(!row)return;
    finish(true);
    const g=gesture={row,id:e.pointerId,x:e.clientX,y:e.clientY,startY:e.clientY,active:false};
    g.timer=setTimeout(()=>{
      if(gesture!==g)return;
      g.active=true;suppressClick=true;row.classList.add('sorting');list.setPointerCapture(g.id);scroll();
    },350);
  });
  list.addEventListener('pointermove',e=>{
    if(!gesture||gesture.id!==e.pointerId)return;
    gesture.y=e.clientY;
    if(!gesture.active){if(Math.hypot(e.clientX-gesture.x,e.clientY-gesture.startY)>7)finish(true);return;}
    e.preventDefault();position();
  });
  window.addEventListener('pointerup',e=>{if(gesture?.id===e.pointerId)finish();});
  list.addEventListener('pointercancel',()=>finish(true));
  list.addEventListener('lostpointercapture',()=>finish(true));
  window.addEventListener('blur',()=>finish(true));
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&gesture){e.preventDefault();finish(true);}},true);
  list.addEventListener('click',e=>{if(suppressClick){e.preventDefault();e.stopImmediatePropagation();suppressClick=false;}},true);
}
