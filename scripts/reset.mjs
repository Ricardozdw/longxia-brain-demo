// 录屏前清空真实任务记录和截图（保留模拟历史数据），让看板从干净状态开始。
// 用法：先关闭服务，再运行 npm run reset
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNTIME = join(dirname(dirname(fileURLToPath(import.meta.url))), '.runtime');
const FILE = join(RUNTIME, 'tasks.json');
const tasks = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : [];
writeFileSync(FILE, JSON.stringify(tasks.filter(t => t.mock), null, 1));
rmSync(join(RUNTIME, 'shots'), { recursive: true, force: true });
console.log(`已清空 ${tasks.filter(t => !t.mock).length} 条真实任务记录（模拟数据保留）`);
