/**
 * Sistema de temas de EstudIO — "Biblioteca Nocturna"
 *
 * La selección del tema vive únicamente en Configuración → Apariencia
 * (botones con [data-appearance]): "system" (sigue al S.O.), "light", "dark".
 * La preferencia se guarda en localStorage como `estudio.theme`.
 * El html/index.html ejecuta un mini-script previo al primer paint que
 * aplica `data-theme` en <html> para evitar el flash de tema incorrecto.
 */

export type ThemeChoice = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "estudio.theme";

function mediaDark(): MediaQueryList {
  return window.matchMedia("(prefers-color-scheme: dark)");
}

export function resolveTheme(choice: ThemeChoice): ResolvedTheme {
  if (choice === "system") {
    return mediaDark().matches ? "dark" : "light";
  }
  return choice;
}

export function getStoredChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* storage bloqueado: usamos "system" */
  }
  return "system";
}

/** Aplica el tema en el DOM sin persistir. */
export function applyTheme(choice: ThemeChoice): ResolvedTheme {
  const resolved = resolveTheme(choice);
  document.documentElement.dataset.theme = resolved;
  return resolved;
}

function syncAppearanceOptions(choice: ThemeChoice) {
  document
    .querySelectorAll<HTMLButtonElement>("[data-appearance]")
    .forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.appearance === choice);
    });
}

/** Cambia la preferencia, la persiste y aplica el tema. */
export function setThemeChoice(choice: ThemeChoice) {
  try {
    localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    /* sin persistencia: se aplica solo en la sesión */
  }
  applyTheme(choice);
  syncAppearanceOptions(choice);
}

function wireAppearanceOptions() {
  document.querySelectorAll<HTMLButtonElement>("[data-appearance]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const choice = btn.dataset.appearance as ThemeChoice | undefined;
      if (choice === "system" || choice === "light" || choice === "dark") {
        setThemeChoice(choice);
      }
    });
  });
}

/**
 * Inicializa el sistema de temas:
 * 1. Aplica la preferencia guardada (o la del sistema).
 * 2. Conecta las opciones de Apariencia del modal de Configuración.
 * 3. Sigue el tema del sistema en vivo mientras la preferencia sea "system".
 *    (En Tauri el WebView expone prefers-color-scheme según el S.O.)
 */
export function initTheme(): void {
  const choice = getStoredChoice();
  applyTheme(choice);
  syncAppearanceOptions(choice);
  wireAppearanceOptions();

  mediaDark().addEventListener("change", () => {
    if (getStoredChoice() === "system") {
      applyTheme("system");
    }
  });
}
