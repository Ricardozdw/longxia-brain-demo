// 执行器内的可预期失败，带上统一异常码（见 src/intent.mjs 的 ERRORS）
export class TaskFailure extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}
