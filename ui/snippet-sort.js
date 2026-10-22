export function setupSnippetSort(list,{commit,restore,rowSelector='.snippet-row',ignoreSelector='.snippet-actions',idKey='snippet',axis='y'}) {
  let gesture=null, suppressClick=false, saving=false;
  function position(){
    if(!gesture?.active)return;
    const {row}=gesture; const point=gesture[axis];
    const children=[...list.children];
    const layout=el=>{const r=el.getBoundingClientRect(),t=new DOMMatrixReadOnly(getComputedStyle(el).transform);return {left:r.left-t.m41,top:r.top-t.m42,width:r.width,height:r.height};};
    const before=children.find(other=>{const r=layout(other);return other!==row && point<(axis==='x'?r.left+r.width/2:r.top+r.height/2);})||null;
    if(row.nextElementSibling===before)return;
    const previous=new Map(children.map(el=>[el,el.getBoundingClientRect()]));
    children.forEach(el=>el.getAnimations().forEach(a=>a.cancel()));
    list.insertBefore(row,before);
    if(!matchMedia('(prefers-reduced-motion: reduce)').matches)for(const el of children){
      const old=previous.get(el),next=el.getBoundingClientRect();
      if(old.left!==next.left||old.top!==next.top)el.animate([{transform:`translate(${old.left-next.left}px,${old.top-next.top}px)`},{transform:'translate(0,0)'}],{duration:160,easing:'ease-out'});
    }
  }
  function scroll(){
    if(!gesture?.active)return;
    const bounds=list.getBoundingClientRect();
    const start=axis==='x'?bounds.left:bounds.top,end=axis==='x'?bounds.right:bounds.bottom;
    const delta=gesture[axis]<start+30?-7:gesture[axis]>end-30?7:0;
    if(delta){if(axis==='x')list.scrollLeft+=delta;else list.scrollTop+=delta;position();}
    gesture.frame=requestAnimationFrame(scroll);
  }
  function finish(cancel=false){
    const g=gesture;if(!g)return;gesture=null;clearTimeout(g.timer);cancelAnimationFrame(g.frame);
    if(list.hasPointerCapture(g.id))list.releasePointerCapture(g.id);
    g.row.classList.remove('sorting');
    if(!g.active)return;
    suppressClick=true;
    if(cancel){restore();return;}
    saving=true;Promise.resolve(commit([...list.children].map(row=>row.dataset[idKey]))).finally(()=>{saving=false;});
  }
  list.addEventListener('pointerdown',e=>{
    suppressClick=false;
    if(saving||e.button!==0||!e.isPrimary||e.target.closest(ignoreSelector))return;
    const row=e.target.closest(rowSelector);if(!row)return;
    finish(true);
    const g=gesture={row,id:e.pointerId,x:e.clientX,startX:e.clientX,y:e.clientY,startY:e.clientY,active:false};
    g.timer=setTimeout(()=>{
      if(gesture!==g)return;
      g.active=true;suppressClick=true;row.classList.add('sorting');list.setPointerCapture(g.id);scroll();
    },180);
  });
  list.addEventListener('pointermove',e=>{
    if(!gesture||gesture.id!==e.pointerId)return;
    gesture.x=e.clientX;gesture.y=e.clientY;
    if(!gesture.active){if(Math.hypot(e.clientX-gesture.startX,e.clientY-gesture.startY)>7)finish(true);return;}
    e.preventDefault();position();
  });
  window.addEventListener('pointerup',e=>{if(gesture?.id===e.pointerId)finish();});
  list.addEventListener('pointercancel',()=>finish(true));
  list.addEventListener('lostpointercapture',()=>finish(true));
  window.addEventListener('blur',()=>finish(true));
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&gesture){e.preventDefault();finish(true);}},true);
  list.addEventListener('click',e=>{if(suppressClick){e.preventDefault();e.stopImmediatePropagation();suppressClick=false;}},true);
}
