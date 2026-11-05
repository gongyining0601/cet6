/* app/sync-config.js —— 私有同步端点配置（唯一需要手填的文件）
 *
 * CET4 / CET6 各自一份，差异只有 namespace 与 endpoint；其余字段保持一致。
 * 留空 = 同步层完全不激活，应用行为与接入前一致（仍可离线刷题、仍可手动导出/导入）。
 * 启用方式：
 *   1. 把 scripts/sync-server.js 部署到一个手机和电脑都能访问到的 https 地址；
 *   2. 把该地址填到下面的 endpoint（两个项目共用一套服务时，用 /cet4 或 /cet6 前缀隔离）；
 *   3. 每台设备首次到「备份 → 跨设备同步 → 立即同步」输入本人的口令即可
 *      （服务端配 SYNC_USERS 时按编号隔离；只配 SYNC_TOKEN 时输入圈子共享口令）。
 *      口令只存在该设备的浏览器里，不会写进本文件、不会随页面发布。
 *   4. userId 留空 = 自动取当前登录的 4 位学习编号，记录按编号分片，互不覆盖。
 *
 * 注意：
 *   · GitHub Pages 是 https，浏览器会拦截 http 混合内容，端点必须是 https；
 *   · 本文件会随页面一起发布（可公开读到），所以 **token 建议始终留空**。
 *     若为了免去每台设备输入而把它写死在这里，等于把圈子口令贴在门上，请先把仓库设为 private。
 *   · 若要做到「每人各自独立口令、互相读不到」，在服务端配置 SYNC_USERS
 *     （详见 docs/同步部署说明.md），每台设备各自输入自己的口令。
 */
(function (root) {
  root.CET_SYNC_CONFIG = {
    namespace: 'cet6',  // 与服务端数据目录、本机口令存储键对应；不要改成 cet4
    endpoint: 'https://gongyining.top/cet6',  // 私有端点（结尾不要带 /）
    token: '',          // 保持留空：由界面首次输入并存本机；写死会随静态文件公开
    userId: '',         // 留空 = 用当前 4 位学习编号；也可为每人显式指定
    debounceMs: 3000,   // save() 后多久推送一次，避免逐键写网络
    timeoutMs: 8000     // 单次请求超时
  };
})(typeof window !== 'undefined' ? window : self);
