// Editing stays in the chosen application; only actionable save problems surface.
export function setupRemoteEdits({call,bridge,report}) {
  const seen=new Map(),latest=new Map(),queue=[];
  let resolving=false;
  const issue=e=>['conflict','failed','waiting'].includes(e.state);
  const key=e=>`${e.state}:${e.error||''}`;
  async function resolve(){
    if(resolving)return;
    resolving=true;
    try{
      while(queue.length){
        const entry=queue.shift(),current=latest.get(entry.id);
        if(!current || !issue(current) || key(current)!==key(entry))continue;
        try{await call('remoteEditResolve',{id:entry.id});}catch(e){report(e);}
      }
    }finally{resolving=false;}
  }
  function update(entries){
    latest.clear();
    for(const entry of entries||[]){
      latest.set(entry.id,entry);
      if(!issue(entry)){seen.delete(entry.id);continue;}
      if(seen.get(entry.id)===key(entry))continue;
      seen.set(entry.id,key(entry));queue.push(entry);
    }
    for(const id of seen.keys())if(!latest.has(id))seen.delete(id);
    resolve();
  }
  bridge?.addEventListener('message',({data})=>{if(data.type==='remoteEdits')update(data.entries);});
  if(bridge)call('remoteEdits').then(update).catch(report);
}
