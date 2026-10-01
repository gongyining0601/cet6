/* CET6 版本号唯一来源（修复"版本号散落三处"）：sw.js 与 index.html 都引用本文件。
   发版/修题库只需把下面的 CET6_VERSION 递增（可用 scripts/_bump_ver.py 一键 +1），
   SW 缓存名、core.js 的缓存穿透参数全部随之刷新。 */
(function (root) {
  root.CET6_VERSION = 'cet6-v24';
})(typeof window !== 'undefined' ? window : self);
