/* 在 <head> 中同步执行，防止深色模式闪屏。不要加 defer。 */
(function () {
  try {
    var saved = localStorage.getItem("blog.theme");
    var mq = window.matchMedia("(prefers-color-scheme: dark)");
    var theme = saved === "light" || saved === "dark" ? saved : mq.matches ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
  } catch (e) {
    document.documentElement.dataset.theme = "light";
  }
})();
