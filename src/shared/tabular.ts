/** Excel-style TSV: quoted cells may contain delimiters, line breaks and escaped quotes. */
export function parseTsv(input:string):string[][] {
  if(input.length>200000)throw new Error('单次粘贴内容过大，请拆分后操作');
  const rows:string[][]=[[]];let cell='',quoted=false,closed=false;
  const endCell=()=>{rows[rows.length-1].push(cell);cell='';closed=false;};
  for(let i=0;i<input.length;i++){
    const c=input[i];
    if(quoted){if(c==='"'){if(input[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=c;continue;}
    if(c==='\t'){endCell();continue;}
    if(c==='\n'||c==='\r'){endCell();if(c==='\r'&&input[i+1]==='\n')i++;rows.push([]);continue;}
    if(closed)throw new Error('粘贴内容的引号格式无效，请重新从表格复制');
    if(c==='"'&&!cell){quoted=true;continue;}cell+=c;
  }
  if(quoted)throw new Error('粘贴内容有未闭合引号，未加入任何修改');
  if(cell||closed||rows[rows.length-1].length||rows.length===1)endCell();else rows.pop();
  return rows;
}
export const serializeTsv=(rows:string[][])=>rows.map(row=>row.map(value=>/[\t\r\n"]/.test(value)?'"'+value.replaceAll('"','""')+'"':value).join('\t')).join('\n');
