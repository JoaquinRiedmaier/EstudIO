import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { showToast } from "./main";

let versionDisponible: string | null = null;

export function getVersionDisponible(): string | null {
  return versionDisponible;
}

/**
 * Muestra la notificación de actualización en la barra superior (popover y pill)
 * y en el modal de configuración.
 */
export function mostrarNotificacionActualizacion(version: string, autoAbrirPopover = true): void {
  versionDisponible = version;

  // 1. Mostrar pill en el topbar
  const btnPill = document.getElementById("btn-update-available");
  const pillText = document.getElementById("update-pill-text");
  if (btnPill && pillText) {
    pillText.textContent = `v${version} disponible`;
    btnPill.style.display = "inline-flex";
  }

  // 2. Configurar y desplegar popover en el topbar
  const popover = document.getElementById("popover-update");
  const popoverTitle = document.getElementById("popover-update-title");
  const popoverBody = document.getElementById("popover-update-body");

  if (popover && popoverTitle && popoverBody) {
    popoverTitle.textContent = `Actualización disponible — v${version}`;
    popoverBody.textContent = `Una nueva versión de EstudIO (v${version}) está lista para descargar e instalar.`;
    if (autoAbrirPopover) {
      popover.style.display = "block";
    }
  }

  // 3. Configurar banner dentro del modal de Configuración
  const banner = document.getElementById("settings-update-banner");
  const bannerText = document.getElementById("settings-update-banner-text");
  if (banner && bannerText) {
    bannerText.textContent = `¡Nueva versión v${version} disponible!`;
    banner.style.display = "flex";
  }
}

/**
 * Cierra el popover emergente superior.
 */
export function cerrarPopoverActualizacion(): void {
  const popover = document.getElementById("popover-update");
  if (popover) {
    popover.style.display = "none";
  }
}

/**
 * Alterna la visibilidad del popover superior.
 */
export function togglePopoverActualizacion(): void {
  const popover = document.getElementById("popover-update");
  if (!popover) return;
  if (popover.style.display === "none" || !popover.style.display) {
    popover.style.display = "block";
  } else {
    popover.style.display = "none";
  }
}

/**
 * Ejecuta la descarga e instalación de la actualización a través de Rust.
 */
async function ejecutarInstalacion(): Promise<void> {
  const btnPopoverNow = document.getElementById("btn-update-now") as HTMLButtonElement | null;
  const btnPopoverLater = document.getElementById("btn-update-later") as HTMLButtonElement | null;
  const btnSettingsNow = document.getElementById("btn-settings-update-now") as HTMLButtonElement | null;

  const setButtonsLoading = (loading: boolean, text: string) => {
    if (btnPopoverNow) {
      btnPopoverNow.disabled = loading;
      btnPopoverNow.textContent = text;
    }
    if (btnSettingsNow) {
      btnSettingsNow.disabled = loading;
      btnSettingsNow.textContent = text;
    }
    if (btnPopoverLater) {
      btnPopoverLater.disabled = loading;
    }
  };

  setButtonsLoading(true, "Descargando…");

  try {
    await invoke("instalar_actualizacion");
    // Si la app no se reinicia automáticamente:
    cerrarPopoverActualizacion();
  } catch (err) {
    console.error("[updater] Error al instalar actualización:", err);
    setButtonsLoading(false, "Error — reintentar");
    showToast(`Error al instalar actualización: ${err}`, "error");
  }
}

/**
 * Inicializa la lógica del actualizador:
 * - Lee la versión instalada.
 * - Registra los eventos de los botones del topbar y del modal de configuración.
 * - Escucha el evento "update-available" emitido por Rust.
 * - Expone window.__testUpdateAvailable para pruebas.
 */
export async function initUpdater(): Promise<void> {
  // Cargar versión actual de la app
  try {
    const versionActual = await getVersion();
    const versionEl = document.getElementById("settings-app-version");
    if (versionEl && versionActual) {
      versionEl.textContent = `v${versionActual}`;
    }
  } catch (e) {
    console.warn("[updater] No se pudo leer getVersion():", e);
  }

  // Clic en el botón Pill de la barra superior (alterna el popover)
  const btnPill = document.getElementById("btn-update-available");
  btnPill?.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePopoverActualizacion();
  });

  // Botón "Más tarde" del popover
  const btnPopoverLater = document.getElementById("btn-update-later");
  btnPopoverLater?.addEventListener("click", (e) => {
    e.stopPropagation();
    cerrarPopoverActualizacion();
  });

  // Botón "Actualizar ahora" del popover
  const btnPopoverNow = document.getElementById("btn-update-now");
  btnPopoverNow?.addEventListener("click", (e) => {
    e.stopPropagation();
    ejecutarInstalacion();
  });

  // Botón "Actualizar ahora" dentro de Configuración
  const btnSettingsNow = document.getElementById("btn-settings-update-now");
  btnSettingsNow?.addEventListener("click", (e) => {
    e.stopPropagation();
    ejecutarInstalacion();
  });

  // Botón "Buscar" actualizaciones en Configuración
  const btnCheck = document.getElementById("btn-settings-check-update") as HTMLButtonElement | null;
  btnCheck?.addEventListener("click", async () => {
    if (!btnCheck) return;
    const originalText = btnCheck.textContent;
    btnCheck.disabled = true;
    btnCheck.textContent = "Buscando…";

    try {
      const nuevaVersion = await invoke<string | null>("verificar_actualizacion_manual");
      if (nuevaVersion) {
        mostrarNotificacionActualizacion(nuevaVersion, true);
        showToast(`¡Nueva versión v${nuevaVersion} disponible!`, "success");
      } else {
        showToast("EstudIO está al día (última versión instalada)", "success");
      }
    } catch (err: any) {
      console.error("[updater] Error al buscar actualizaciones:", err);
      showToast(`No se pudo verificar actualizaciones: ${err}`, "error");
    } finally {
      btnCheck.disabled = false;
      btnCheck.textContent = originalText;
    }
  });

  // Cerrar el popover si se hace clic fuera de él
  document.addEventListener("click", (e) => {
    const popover = document.getElementById("popover-update");
    const target = e.target as HTMLElement;
    if (popover && popover.style.display !== "none" && !popover.contains(target) && !btnPill?.contains(target)) {
      cerrarPopoverActualizacion();
    }
  });

  // Escuchar evento de actualización emitido por Rust
  await listen<string>("update-available", (event) => {
    console.log("[updater] Nueva versión detectada por Rust:", event.payload);
    mostrarNotificacionActualizacion(event.payload, true);
  });

  // Modo de prueba para verificar la UI de inmediato
  (window as any).__testUpdateAvailable = (version = "1.2.4") => {
    console.log("[updater test] Disparando notificación de prueba con versión:", version);
    mostrarNotificacionActualizacion(version, true);
  };
}

