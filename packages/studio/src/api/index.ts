import { startStudioServer } from "./server.js";
import { runStartupSnapshot } from "./startup-snapshot.js";
import { resolve } from "node:path";

const root = resolve(process.argv[2] ?? process.env.JUANSHE_WORKSPACE ?? process.env.HARDWRITE_PROJECT_ROOT ?? process.cwd());
const port = parseInt(process.env.JUANSHE_API_PORT ?? process.env.HARDWRITE_STUDIO_PORT ?? "4567", 10);

// 启动前自动快照所有书的真相文件（防强停/重启把状态写截断；零破坏、纯加备份）
await runStartupSnapshot(root);

startStudioServer(root, port).catch((e) => {
  console.error("Failed to start studio:", e);
  process.exit(1);
});
