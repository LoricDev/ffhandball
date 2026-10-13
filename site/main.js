(() => {
  const base = ((window.FFHB_CONFIG || {}).baseUrl || "").replace(/\/+$/, "");

  // URL de l'API dans les exemples et les liens.
  document.querySelectorAll("[data-base]").forEach((el) => { el.textContent = base; });
  document.querySelectorAll("[data-docs]").forEach((a) => { a.href = base + "/docs"; });
  document.querySelectorAll("[data-openapi]").forEach((a) => { a.href = base + "/openapi.json"; });
  document.querySelectorAll("[data-health]").forEach((a) => { a.href = base + "/health"; });

  // Onglets (flèches gauche/droite, un seul panneau visible).
  document.querySelectorAll('[role="tablist"]').forEach((list) => {
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    const select = (tab) => {
      tabs.forEach((t) => {
        const on = t === tab;
        t.setAttribute("aria-selected", String(on));
        t.tabIndex = on ? 0 : -1;
        document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
      });
    };
    tabs.forEach((tab, i) => {
      tab.addEventListener("click", () => select(tab));
      tab.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
        select(next);
        next.focus();
      });
    });
  });

  // Bouton « Copier ».
  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const code = document.getElementById(btn.dataset.copy).querySelector("code").innerText;
      try {
        await navigator.clipboard.writeText(code);
        btn.textContent = "Copié";
      } catch {
        btn.textContent = "Copie impossible";
      }
      setTimeout(() => { btn.textContent = "Copier"; }, 1800);
    });
  });
})();
