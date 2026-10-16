(function () {
  var theme;
  try {
    theme = localStorage.getItem("video-hub-public-theme");
  } catch (_) {}
  if (theme !== "light" && theme !== "dark") {
    theme =
      typeof matchMedia === "function" &&
      matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  }
  document.documentElement.setAttribute("data-public-theme", theme);
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta)
    meta.setAttribute("content", theme === "dark" ? "#18313d" : "#f5f2e9");
})();
