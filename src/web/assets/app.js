// Progressive enhancement only — every view in `slop web` works fully
// without this file (filters are plain GET forms, everything else is
// plain links/<details>). This just adds an instant client-side substring
// filter on top of the server-rendered ticket list table, so typing in the
// search box narrows rows immediately instead of waiting for a submit.
// If this script fails to load (offline build issue, blocked script,
// whatever), the "Filter" button still works because the form is a real
// GET form.
(() => {
  const setup = () => {
    const input = document.querySelector("[data-live-filter]");
    const table = document.querySelector("[data-filter-target]");
    if (!input || !table) return;

    const rows = Array.prototype.slice.call(table.querySelectorAll("tbody tr"));

    input.addEventListener("input", () => {
      const needle = input.value.trim().toLowerCase();
      rows.forEach((row) => {
        const haystack = (row.getAttribute("data-search") || "").toLowerCase();
        row.style.display = needle === "" || haystack.indexOf(needle) !== -1 ? "" : "none";
      });
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setup);
  } else {
    setup();
  }
})();
