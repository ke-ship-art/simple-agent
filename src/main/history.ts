/** Complete interrupted protocol frames in place; preserve user and assistant content. */
export function closePendingTools(context: unknown[], message: string) {
  const repaired: any[] = []; let pending = new Map<string, any>(), changed = false;
  const close = () => { for (const call of pending.values()) { repaired.push({role:'toolResult',toolCallId:call.id,toolName:call.name,content:[{type:'text',text:message}],isError:true,timestamp:Date.now()}); changed=true; } pending.clear(); };
  for (const frame of context as any[]) {
    if(frame.role!=='toolResult'&&pending.size)close();
    repaired.push(frame);
    if(frame.role==='assistant'&&Array.isArray(frame.content)) pending=new Map(frame.content.filter((b:any)=>b.type==='toolCall').map((b:any)=>[b.id,b]));
    if(frame.role==='toolResult')pending.delete(frame.toolCallId);
  }
  close();if(changed)context.splice(0,context.length,...repaired);return changed;
}
