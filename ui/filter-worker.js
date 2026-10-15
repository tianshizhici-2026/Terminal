self.onmessage = ({data}) => {
  try {
    const pattern = new RegExp(data.pattern, 'iu');
    self.postMessage({indices:data.names.flatMap((name,index)=>pattern.test(name)?[index]:[])});
  } catch { self.postMessage({error:'正则表达式无效'}); }
};
