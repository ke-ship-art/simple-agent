/** Serialize settings/network work against task startup; release only when work has settled. */
export class OperationGate {
  private controller?: AbortController;
  assertIdle() { if(this.controller)throw new Error('设置正在保存或连接正在测试，请等待完成或取消测试'); }
  cancel() { this.controller?.abort(new Error('连接测试已取消')); }
  async run<T>(work:(signal:AbortSignal)=>Promise<T>) {
    this.assertIdle();const controller=new AbortController();this.controller=controller;
    try{return await work(controller.signal);}finally{if(this.controller===controller)this.controller=undefined;}
  }
}
