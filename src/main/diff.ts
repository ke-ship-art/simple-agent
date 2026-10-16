import { createPatch } from 'diff';
/** Yield between edit-distance steps and bound pathological, wholly different documents. */
export function reviewPatch(path: string, before: string, after: string, oldHeader='修改前', newHeader='修改后'): Promise<string> {
  if(before.length+after.length>8*1024*1024)return Promise.reject(new Error('本次差异内容过大，无法安全审核，请拆分操作；文件未写入'));
  return new Promise((resolve,reject)=>{
    createPatch(path,before,after,oldHeader,newHeader,{timeout:1000,maxEditLength:10000,callback:patch=>{
      if(!patch||patch.length>4*1024*1024)reject(new Error('差异计算达到复杂度或大小上限，请拆分修改；文件未写入'));
      else resolve(patch);
    }});
  });
}
