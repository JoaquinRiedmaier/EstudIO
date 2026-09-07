import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";

import { readImage } from "@tauri-apps/plugin-clipboard-manager";
import { seleccionarRuta } from "./file";
import { Editor, Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

import { jsPDF } from "jspdf";
// @ts-ignore
import html2pdf from "html2pdf.js";

import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { Markdown } from "@tiptap/markdown";
import Highlight from "@tiptap/extension-highlight";
import { marked } from "marked";
import TurndownService from "turndown";
// @ts-ignore
import { gfm } from "turndown-plugin-gfm";
import { initUpdater } from "./updater";

// Inicializar el listener de actualizaciones (responde al evento emitido por Rust)
initUpdater().catch((e) => console.error("[updater] No se pudo inicializar:", e));

const turndownService = new TurndownService({ headingStyle: "atx" });
turndownService.use(gfm);
turndownService.keep(["mark"]);

turndownService.addRule("preserve-image-dims", {
  filter: (node: any) => {
    return (
      node.nodeName === "IMG" &&
      (node.getAttribute("width") || node.getAttribute("height"))
    );
  },
  replacement: (_content: string, node: any) => {
    return node.outerHTML;
  },
});

const TabExtension = Extension.create({
  name: 'tabExtension',
  addKeyboardShortcuts() {
    return {
      Tab: () => {
        // Inserta un tabulador real
        return this.editor.commands.insertContent('\t');
      },
      'Shift-Tab': () => {
        return this.editor.commands.command(({ tr, state, dispatch }) => {
          const { $from, empty } = state.selection;

          if (empty) {
            // Obtener el texto justo antes del cursor (1 caracter)
            const textBefore = $from.parent.textBetween(
              Math.max(0, $from.parentOffset - 1),
              $from.parentOffset
            );

            // Si es un tabulador, lo borramos
            if (textBefore === '\t') {
              if (dispatch) {
                tr.delete($from.pos - 1, $from.pos);
              }
              return true;
            }
          }
          return false;
        });
      },
    };
  },
});

// Define Interfaces
interface Materia {
  codigo: number;
  nombre: string;
  ano: number;
  cuatrimestre: number;
  anual: boolean;
}

interface Apunte {
  codigo_apunte: number;
  tema: string;
  materia_codigo: number;
  fecha_creacion: string;
  ult_modificacion: string;
  ruta: string;
  sincronizar_drive?: boolean;
}

interface Evento {
  codigo_evento: number;
  fecha: string;
  hora: string;
  fecha_recordar: string;
  nombre: string;
  descripcion: string;
}

interface SlotHorario {
  id_slot: number;
  titulo: string;
  dia_semana: number;
  hora_inicio: number; // minutos desde medianoche
  hora_fin: number;
  color: string;
  aula: string | null;
}

// State
let materiasCache: Materia[] = [];
let eventosCache: Evento[] = [];
let slotsCache: SlotHorario[] = [];
let currentCalendarDate = new Date();
let editorInstancia: Editor | null = null;
let currentEditPath: string = "";
let currentEditCodigo: number | null = null;
let materiaToDelete: string | null = null;
let selectedHighlightColor = "#fef08a";

// ZIP import state (selected materia)
let currentMateriaForModal: Materia | null = null;

const CustomPasteExtension = Extension.create({
  name: "customPaste",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("customPasteHandler"),
        props: {
          handlePaste(_view, event, _slice) {
            console.log("CustomPasteExtension: Interceptando evento de pegado");

            // Si hay texto o HTML en el portapapeles, delegamos al comportamiento nativo de ProseMirror/TipTap
            if (event.clipboardData) {
              const types = event.clipboardData.types;
              if (types.includes("text/plain") || types.includes("text/html")) {
                console.log("Detectado texto/HTML en el portapapeles, delegando a TipTap");
                return false;
              }
            }

            // Si no hay texto/HTML, asumimos que es una imagen e intentamos pegarla vía Tauri
            event.preventDefault();
            event.stopImmediatePropagation();

            (async () => {
              try {
                console.log("Intentando leer imagen desde el portapapeles de Tauri...");
                const clipboardImage = await readImage();

                const size = await clipboardImage.size();
                const rgbaBytes = await clipboardImage.rgba();

                // Convert RGBA bytes to Base64 using a temporary canvas
                const canvas = document.createElement("canvas");
                canvas.width = size.width;
                canvas.height = size.height;
                const ctx = canvas.getContext("2d");
                if (!ctx) {
                  throw new Error("No se pudo obtener el contexto 2D del canvas");
                }

                const imgData = ctx.createImageData(size.width, size.height);
                imgData.data.set(rgbaBytes);
                ctx.putImageData(imgData, 0, 0);

                const dataUrl = canvas.toDataURL("image/png");
                const commaIdx = dataUrl.indexOf(",");
                if (commaIdx === -1) {
                  throw new Error("Formato de URL de datos inválido");
                }
                const base64Data = dataUrl.substring(commaIdx + 1);

                console.log("Guardando imagen en el backend...");
                const rutaRelativa = await invoke<string>("paste_imagen", {
                  rutaApunte: currentEditPath,
                  imagen: base64Data,
                });

                const lastSlash = Math.max(
                  currentEditPath.lastIndexOf("/"),
                  currentEditPath.lastIndexOf("\\"),
                );
                const parentDir =
                  lastSlash !== -1 ? currentEditPath.substring(0, lastSlash) : "";
                const absolutePath = parentDir
                  ? `${parentDir}/${rutaRelativa}`
                  : rutaRelativa;
                const assetUrl = convertFileSrc(absolutePath);

                // Insert the image
                editorInstancia?.chain().focus().setImage({ src: assetUrl }).run();
                showToast("Imagen pegada correctamente", "success");

                // Close the image resource to free memory
                await clipboardImage.close();
              } catch (error: any) {
                console.error("Error al pegar imagen desde Tauri:", error);
              }
            })();

            return true; // Cancel default web paste behavior
          }
        }
      })
    ];
  }
});



// DOM Elements
document.addEventListener("DOMContentLoaded", () => {
  setupNavigation();
  setupForms();
  setupCalendar();
  setupModal();
  setupEditor();
  setupZipActions();
  setupHorarios();
  setupSettings();
  setupBienvenida();
  setupCloudSync();
  setupDriveImport();
  cargarUltimosModificados();
  cargarMaterias();
  cargarRecordatoriosHoy();
  sincronizarApuntesAlInicio();
});

// ─── Settings & Welcome ────────────────────────────────────────────────────

function abrirModal(id: string) {
  document.getElementById(id)?.classList.add("active");
}

function cerrarModal(id: string) {
  document.getElementById(id)?.classList.remove("active");
}

function setupSettings() {
  // Abrir settings
  document.getElementById("btn-settings")?.addEventListener("click", () => {
    abrirModal("modal-settings");
  });

  // Cerrar settings al hacer clic fuera del contenido
  document.getElementById("modal-settings")?.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).id === "modal-settings") {
      cerrarModal("modal-settings");
    }
  });

  document
    .getElementById("btn-cerrar-settings")
    ?.addEventListener("click", () => {
      cerrarModal("modal-settings");
    });

  // Desde settings → abrir atajos
  document.getElementById("btn-ver-atajos")?.addEventListener("click", () => {
    cerrarModal("modal-settings");
    abrirModal("modal-atajos");
  });

  // Cerrar atajos
  document.getElementById("modal-atajos")?.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).id === "modal-atajos") {
      cerrarModal("modal-atajos");
    }
  });

  document
    .getElementById("btn-cerrar-atajos")
    ?.addEventListener("click", () => {
      cerrarModal("modal-atajos");
    });
}

function setupBienvenida() {
  const STORAGE_KEY = "estudio_bienvenida_v1";
  const yaVisto = localStorage.getItem(STORAGE_KEY);

  if (!yaVisto) {
    // Primera vez: mostrar el modal de bienvenida
    setTimeout(() => abrirModal("modal-bienvenida"), 300);
  }

  document
    .getElementById("btn-cerrar-bienvenida")
    ?.addEventListener("click", () => {
      localStorage.setItem(STORAGE_KEY, "1");
      cerrarModal("modal-bienvenida");
    });

  // También cerrar al hacer clic fuera
  document
    .getElementById("modal-bienvenida")
    ?.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).id === "modal-bienvenida") {
        localStorage.setItem(STORAGE_KEY, "1");
        cerrarModal("modal-bienvenida");
      }
    });
}

function getTodayBackendDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}/${m}/${d}`;
}

function getParentDirFromPath(filePath: string): string {
  const lastSlash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return lastSlash !== -1 ? filePath.substring(0, lastSlash) : "";
}

function recortarRutaRecursos(src: string): string {
  if (!src) return src;
  let decoded = src;
  try {
    decoded = decodeURIComponent(src);
  } catch (_) {}

  // Extrae .recursos/<nombre_archivo> independientemente de si viene como asset://, file://, o con codificación
  const match = decoded.match(/\.recursos[\/\\]([^\s"')<>]+)/);
  if (match) {
    return `.recursos/${match[1]}`;
  }
  return src;
}

function joinPath(dir: string, fileName: string): string {
  if (!dir) return fileName;
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.endsWith(sep) ? `${dir}${fileName}` : `${dir}${sep}${fileName}`;
}

function isUserCancelledDialog(err: any): boolean {
  const msg = String(err ?? "").toLowerCase();
  return msg.includes("cancel") || msg.includes("canceled") || msg.includes("cancelled");
}

function setButtonLoading(btn: HTMLButtonElement, loading: boolean, loadingText?: string) {
  if (!btn) return;
  if (loading) {
    btn.disabled = true;
    btn.dataset.originalText = btn.textContent ?? "";
    if (loadingText) btn.textContent = loadingText;
  } else {
    btn.disabled = false;
    if (btn.dataset.originalText) btn.textContent = btn.dataset.originalText;
    delete btn.dataset.originalText;
  }
}

function setupZipActions() {
  // Import ZIP (global on Materias view)
  const btnImportGlobal = document.getElementById("btn-import-zip") as HTMLButtonElement | null;
  btnImportGlobal?.addEventListener("click", async () => {
    await importarNotaZipFlow(null, btnImportGlobal);
  });

  // Import ZIP (inside modal for a specific materia)
  const btnImportModal = document.getElementById("btn-modal-importar-zip") as HTMLButtonElement | null;
  btnImportModal?.addEventListener("click", async () => {
    await importarNotaZipFlow(currentMateriaForModal, btnImportModal);
  });
}

async function importarNotaZipFlow(
  materiaPreferida: Materia | null,
  triggerBtn?: HTMLButtonElement | null,
) {
  const btn = triggerBtn ?? null;
  try {
    if (btn) setButtonLoading(btn, true, "Importando…");

    // 1) Materia
    let materiaCodigo: string | undefined;
    let materiaNombre: string | undefined;
    if (materiaPreferida) {
      materiaCodigo = materiaPreferida.codigo.toString();
      materiaNombre = materiaPreferida.nombre;
    } else {
      // Pick from existing materias
      if (!materiasCache || materiasCache.length === 0) {
        try {
          materiasCache = await invoke<Materia[]>("mostrar_materias");
        } catch (e) {
          // ignore, will show error below
        }
      }
      if (!materiasCache || materiasCache.length === 0) {
        showToast("No hay materias disponibles para importar", "error");
        return;
      }

      const listado = materiasCache
        .map((m, i) => `${i + 1}) ${m.nombre} (#${m.codigo})`)
        .join("\n");
      const idxStr = window.prompt(
        `Seleccioná la materia destino (ingresá el número):\n\n${listado}`,
        "1",
      );
      if (!idxStr) return; // cancelled
      const idx = Number(idxStr);
      if (!Number.isFinite(idx) || idx < 1 || idx > materiasCache.length) {
        showToast("Selección de materia inválida", "error");
        return;
      }
      const mat = materiasCache[idx - 1];
      materiaCodigo = mat.codigo.toString();
      materiaNombre = mat.nombre;
    }

    // 2) ZIP file
    const zipPath = (await open({
      title: "Elegí el archivo zip",
      multiple: false,
      directory: false,
      filters: [{ name: "ZIP", extensions: ["zip"] }],
    })) as string | null;
    if (!zipPath) return; // cancelled

    // 3) Destination folder
    const destino = (await open({
      title: "Elegí donde guardar este apunte",
      multiple: false,
      directory: true,
    })) as string | null;
    if (!destino) return; // cancelled

    const fecha = getTodayBackendDate();
    // Nota: el proyecto usa camelCase en el frontend y el backend (Rust) recibe snake_case.
    // Tauri hace el mapeo automáticamente (ej: rutaApunte -> ruta_apunte).
    const apunte = await invoke<Apunte>("extraer_zip", {
      materiaCodigo: materiaCodigo,
      rutaZip: zipPath,
      rutaDestino: destino,
      fechaCreacion: fecha,
      ultModificacion: fecha,
    });

    // Update lists
    showToast(`Nota importada correctamente${materiaNombre ? ` en ${materiaNombre}` : ""}: ${apunte.tema}`,
      "success",
    );
    cargarUltimosModificados();
    if (materiaPreferida) {
      // refresh modal list
      await abrirModalVerApuntes(materiaPreferida);
    }
  } catch (err: any) {
    if (isUserCancelledDialog(err)) return;
    console.error("Error importando nota ZIP:", err);
    showToast(`Importación fallida: ${err?.toString?.() ?? String(err)}`, "error");
  } finally {
    if (btn) setButtonLoading(btn, false);
  }
}

function setupNavigation() {
  const navBtns = document.querySelectorAll(".nav-btn");
  const views = document.querySelectorAll(".view");
  const titleEl = document.getElementById("view-title");
  const topbarTabs = document.getElementById("topbar-tabs");

  navBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      // Remove editor mode if navigating away via sidebar
      const appContainer = document.querySelector(".app-container");
      if (appContainer) {
        appContainer.classList.remove("editor-mode");
        appContainer.classList.remove("sidebar-collapsed");
        appContainer.classList.remove("sidebar-visible");
      }

      // Update active button
      navBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      // Show target view
      const targetId = btn.getAttribute("data-target");
      views.forEach((v) => v.classList.remove("active"));
      document.getElementById(targetId || "")?.classList.add("active");

      if (targetId === "view-materias") {
        if (titleEl) titleEl.style.display = "none";
        if (topbarTabs) topbarTabs.style.display = "flex";

        // Reset to first tab
        document
          .querySelectorAll(".topbar-tab")
          .forEach((t) => t.classList.remove("active"));
        document
          .querySelector(".topbar-tab[data-tab-target='view-materias']")
          ?.classList.add("active");

        cargarMaterias();
      } else {
        if (titleEl) {
          titleEl.style.display = "block";
          titleEl.textContent = btn.textContent?.trim() || "";
        }
        if (topbarTabs) topbarTabs.style.display = "none";

        if (targetId === "view-nuevo-apunte") {
          cargarSelectorMaterias();
        }
      }
      cargarRecordatoriosHoy();
    });
  });

  const topTabs = document.querySelectorAll(".topbar-tab");
  topTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      topTabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");

      const targetId = tab.getAttribute("data-tab-target");
      views.forEach((v) => v.classList.remove("active"));
      document.getElementById(targetId || "")?.classList.add("active");

      if (targetId === "view-materias") {
        cargarMaterias();
      } else if (targetId === "view-recordatorios") {
        cargarRecordatorios();
      } else if (targetId === "view-horarios") {
        cargarHorarios();
      }
      cargarRecordatoriosHoy();
    });
  });
}

// ─── Helpers de horario ────────────────────────────────────────────────────

/** Convierte "HH:MM" a minutos desde medianoche */
function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

/** Convierte minutos a "HH:MM" */
function minutesToTime(mins: number): string {
  const hh = Math.floor(mins / 60).toString().padStart(2, "0");
  const mm = (mins % 60).toString().padStart(2, "0");
  return `${hh}:${mm}`;
}

const DIAS_NOMBRES: Record<number, string> = {
  0: "Domingo",
  1: "Lunes",
  2: "Martes",
  3: "Miércoles",
  4: "Jueves",
  5: "Viernes",
  6: "Sábado",
};

async function cargarHorarios() {
  try {
    slotsCache = await invoke<SlotHorario[]>("mostrar_slots_horario");
    renderizarGrillaHorario();
  } catch (err) {
    showToast(`Error cargando horario: ${err}`, "error");
  }
  // Poblar datalist de autocompletado con materias existentes
  const dl = document.getElementById("datalist-materias-horario");
  if (dl) {
    dl.innerHTML = "";
    (materiasCache.length
      ? Promise.resolve(materiasCache)
      : invoke<Materia[]>("mostrar_materias")
    )
      .then((ms) => {
        materiasCache = ms;
        ms.forEach((m) => {
          const opt = document.createElement("option");
          opt.value = m.nombre;
          dl.appendChild(opt);
        });
      })
      .catch(() => {});
  }
}

function renderizarGrillaHorario() {
  const grid = document.getElementById("horario-grid");
  const emptyMsg = document.getElementById("horario-empty-msg");
  if (!grid) return;

  grid.innerHTML = "";

  if (slotsCache.length === 0) {
    emptyMsg?.classList.add("visible");
    return;
  }
  emptyMsg?.classList.remove("visible");

  // Agrupar por día en orden Lunes → Domingo
  const diasOrden = [1, 2, 3, 4, 5, 6, 0];
  const porDia = new Map<number, SlotHorario[]>();
  for (const slot of slotsCache) {
    if (!porDia.has(slot.dia_semana)) porDia.set(slot.dia_semana, []);
    porDia.get(slot.dia_semana)!.push(slot);
  }

  for (const dia of diasOrden) {
    const slots = porDia.get(dia);
    if (!slots || slots.length === 0) continue;

    const col = document.createElement("div");
    col.className = "horario-dia-col";

    const header = document.createElement("div");
    header.className = "horario-dia-header";
    header.textContent = DIAS_NOMBRES[dia];
    col.appendChild(header);

    for (const slot of slots) {
      // Detectar solapamiento con otros slots del mismo día
      const solapa = slots.some(
        (otro) =>
          otro.id_slot !== slot.id_slot &&
          slot.hora_inicio < otro.hora_fin &&
          slot.hora_fin > otro.hora_inicio,
      );

      const card = document.createElement("div");
      card.className = "slot-card" + (solapa ? " solapado" : "");
      card.style.borderLeftColor = slot.color;

      const aulaHtml = slot.aula
        ? `<div class="slot-card-aula">📍 ${slot.aula}</div>`
        : "";

      card.innerHTML = `
        <div class="slot-card-titulo">${slot.titulo}</div>
        <div class="slot-card-hora">${minutesToTime(slot.hora_inicio)} – ${minutesToTime(slot.hora_fin)}</div>
        ${aulaHtml}
        <button class="slot-card-del" title="Eliminar bloque" aria-label="Eliminar">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
          </svg>
        </button>
      `;

      const delBtn = card.querySelector(".slot-card-del") as HTMLButtonElement;
      delBtn.addEventListener("click", async () => {
        try {
          await invoke<string>("borrar_slot_horario", { idSlot: slot.id_slot });
          slotsCache = slotsCache.filter((s) => s.id_slot !== slot.id_slot);
          renderizarGrillaHorario();
          showToast("Bloque eliminado", "success");
        } catch (err) {
          showToast(`Error al borrar bloque: ${err}`, "error");
        }
      });

      col.appendChild(card);
    }

    grid.appendChild(col);
  }
}

function setupHorarios() {
  // Modal nuevo bloque horario
  const modalSlot = document.getElementById("modal-slot");
  const btnNuevoSlot = document.getElementById("btn-nuevo-slot");
  const closeBtnModalSlot = document.getElementById("close-modal-slot");

  btnNuevoSlot?.addEventListener("click", () => {
    abrirModal("modal-slot");
    setTimeout(() => {
      (document.getElementById("slot-titulo") as HTMLInputElement)?.focus();
    }, 50);
  });

  closeBtnModalSlot?.addEventListener("click", () => {
    cerrarModal("modal-slot");
  });

  modalSlot?.addEventListener("click", (e) => {
    if (e.target === modalSlot) {
      cerrarModal("modal-slot");
    }
  });

  // Handler del formulario
  const formSlot = document.getElementById("form-slot");
  formSlot?.addEventListener("submit", async (e) => {
    e.preventDefault();

    const titulo = (
      document.getElementById("slot-titulo") as HTMLInputElement
    ).value.trim();
    const dia = parseInt(
      (document.getElementById("slot-dia") as HTMLSelectElement).value,
    );
    const inicioStr = (
      document.getElementById("slot-inicio") as HTMLInputElement
    ).value;
    const finStr = (
      document.getElementById("slot-fin") as HTMLInputElement
    ).value;
    const color = (
      document.getElementById("slot-color") as HTMLInputElement
    ).value;
    const aulaVal = (
      document.getElementById("slot-aula") as HTMLInputElement
    ).value.trim();

    if (!inicioStr || !finStr) {
      showToast("Completá las horas de inicio y fin", "error");
      return;
    }

    const inicio = timeToMinutes(inicioStr);
    const fin = timeToMinutes(finStr);

    if (fin <= inicio) {
      showToast(
        "La hora de fin debe ser posterior a la hora de inicio",
        "error",
      );
      return;
    }

    // Detección de solapamiento
    const slotsMismoDia = slotsCache.filter((s) => s.dia_semana === dia);
    const solapa = slotsMismoDia.some(
      (s) => inicio < s.hora_fin && fin > s.hora_inicio,
    );

    if (solapa) {
      const seguir = await confirm(
        "Este bloque se superpone con otro bloque del mismo día. ¿Deseás agregarlo de todas formas?",
      );
      if (!seguir) return;
    }

    try {
      await invoke<string>("crear_slot_horario", {
        titulo,
        diaSemana: dia,
        horaInicio: inicio,
        horaFin: fin,
        color,
        aula: aulaVal || null,
      });
      showToast("Bloque agregado al horario", "success");
      (formSlot as HTMLFormElement).reset();
      // Resetear selección de color
      const swatches = document.querySelectorAll(".slot-color-swatch");
      swatches.forEach((sw) => sw.classList.remove("active"));
      swatches[0]?.classList.add("active");
      (document.getElementById("slot-color") as HTMLInputElement).value =
        "#2c4c3b";

      await cargarHorarios();
      cerrarModal("modal-slot");
    } catch (err) {
      showToast(`Error al guardar: ${err}`, "error");
    }
  });

  // Paleta de colores
  const swatches = document.querySelectorAll(".slot-color-swatch");
  swatches.forEach((sw) => {
    sw.addEventListener("click", () => {
      swatches.forEach((s) => s.classList.remove("active"));
      sw.classList.add("active");
      const color = (sw as HTMLElement).dataset.color || "#2c4c3b";
      (document.getElementById("slot-color") as HTMLInputElement).value = color;
    });
  });

  // Botón Borrar todo
  const btnBorrarTodos = document.getElementById(
    "btn-borrar-todos-slots",
  ) as HTMLButtonElement;
  btnBorrarTodos?.addEventListener("click", async () => {
    if (slotsCache.length === 0) {
      showToast("El horario ya está vacío", "error");
      return;
    }
    const ok = await confirm(
      "¿Estás seguro de que deseas borrar todos los bloques del horario? Esta acción no se puede deshacer.",
    );
    if (!ok) return;
    try {
      await invoke<string>("borrar_todos_slots");
      slotsCache = [];
      renderizarGrillaHorario();
      showToast("Horario borrado", "success");
    } catch (err) {
      showToast(`Error: ${err}`, "error");
    }
  });

  // ── Exportar horario ─────────────────────────────────────────────────────
  const btnExportarHorario = document.getElementById(
    "btn-exportar-horario",
  ) as HTMLButtonElement | null;
  btnExportarHorario?.addEventListener("click", async () => {
    if (slotsCache.length === 0) {
      showToast("No hay bloques para exportar", "error");
      return;
    }
    try {
      const rutaDestino = await save({
        title: "Exportar horario",
        defaultPath: "mi_horario.json",
        filters: [{ name: "Horario EstudIO", extensions: ["json"] }],
      });
      if (!rutaDestino) return; // El usuario canceló
      await invoke("exportar_horario", { rutaDestino });
      showToast("Horario exportado correctamente", "success");
    } catch (err) {
      showToast(`Error al exportar: ${err}`, "error");
    }
  });

  // ── Importar horario ─────────────────────────────────────────────────────
  const btnImportarHorario = document.getElementById(
    "btn-importar-horario",
  ) as HTMLButtonElement | null;
  btnImportarHorario?.addEventListener("click", async () => {
    try {
      const rutaArchivo = await open({
        title: "Importar horario",
        multiple: false,
        filters: [{ name: "Horario EstudIO", extensions: ["json", "hrf"] }],
      });
      if (!rutaArchivo) return; // El usuario canceló

      // Preguntar modo de importación
      const reemplazar = await confirm(
        "¿Deseás reemplazar el horario actual con el del archivo?\n\n" +
        "• Aceptar → reemplaza todo el horario actual.\n" +
        "• Cancelar → agrega los bloques al horario existente.",
        { title: "Importar horario", kind: "warning" },
      );

      const insertados = await invoke<number>("importar_horario", {
        rutaArchivo,
        reemplazar,
      });
      await cargarHorarios();
      showToast(
        `${insertados} bloque${insertados !== 1 ? "s" : ""} importado${insertados !== 1 ? "s" : ""} correctamente`,
        "success",
      );
    } catch (err) {
      showToast(`Error al importar: ${err}`, "error");
    }
  });
}


function setupForms() {
  const matAnual = document.getElementById("mat-anual") as HTMLInputElement;
  const matCuatrimestre = document.getElementById(
    "mat-cuatrimestre",
  ) as HTMLInputElement;

  matAnual?.addEventListener("change", () => {
    if (matAnual.checked) {
      matCuatrimestre.disabled = true;
      matCuatrimestre.value = "";
    } else {
      matCuatrimestre.disabled = false;
    }
  });

  const formMateria = document.getElementById("form-materia");
  formMateria?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const nombre = (document.getElementById("mat-nombre") as HTMLInputElement)
      .value;
    const ano = parseInt(
      (document.getElementById("mat-ano") as HTMLInputElement).value,
    );
    const anual = matAnual.checked;
    const cuatrimestre = anual ? 0 : parseInt(matCuatrimestre.value);

    try {
      const resp = await invoke<string>("crear_materia", {
        nombre,
        ano,
        cuatrimestre,
        anual,
      });
      showToast(resp, "success");
      (formMateria as HTMLFormElement).reset();
      matCuatrimestre.disabled = false; // Reset state
    } catch (err: any) {
      showToast(err.toString(), "error");
    }
  });

  const formApunte = document.getElementById("form-apunte");
  formApunte?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const tema = (document.getElementById("apu-tema") as HTMLInputElement)
      .value;
    const materiaCodigo = (
      document.getElementById("apu-materia") as HTMLSelectElement
    ).value;

    // Auto-generate current date for creation
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const hours = String(now.getHours()).padStart(2, "0");
    const minutes = String(now.getMinutes()).padStart(2, "0");
    const fechaCreacion = `${year}-${month}-${day} ${hours}:${minutes}`;

    const ruta = (document.getElementById("apu-ruta") as HTMLInputElement)
      .value;

    if (!materiaCodigo) {
      showToast("Por favor selecciona una materia", "error");
      return;
    }

    try {
      const resp = await invoke<Apunte>("crear_apunte", {
        tema,
        materiaCodigo,
        fechaCreacion,
        ultModificacion: fechaCreacion,
        ruta,
      });
      showToast("Apunte registrado exitosamente.", "success");
      (formApunte as HTMLFormElement).reset();
      cargarUltimosModificados();
      await abrirEditor(resp);
    } catch (err: any) {
      showToast(err.toString(), "error");
    }
  });

  const formEvento = document.getElementById("form-evento");
  formEvento?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const nombre = (document.getElementById("evt-nombre") as HTMLInputElement)
      .value;
    let fecha = (document.getElementById("evt-fecha") as HTMLInputElement)
      .value;
    let hora = (document.getElementById("evt-hora") as HTMLInputElement).value;
    const descripcion = (
      document.getElementById("evt-descripcion") as HTMLInputElement
    ).value;
    const opcionRecordar = parseInt(
      (document.getElementById("evt-recordar") as HTMLSelectElement).value,
    );

    if (!hora) {
      if (opcionRecordar === 0) {
        showToast(
          "Ingresa una hora si queres que se te recuerde una hora antes",
          "error",
        );
        return;
      }
      hora = "08:00";
    }

    const fParts = fecha.split("/");
    if (fParts.length === 2 || fParts.length === 3) {
      if (fParts[0].length !== 2 || fParts[1].length !== 2) {
        showToast(
          "El día y el mes deben tener 2 dígitos (ej. 06/05/2026)",
          "error",
        );
        return;
      }
      let year = new Date().getFullYear().toString();
      if (fParts.length === 3) {
        year = fParts[2];
        if (year.length === 2) year = `20${year}`;
      }
      fecha = `${year}/${fParts[1]}/${fParts[0]}`;
    } else {
      showToast("Formato de fecha inválido. Usa DD/MM o DD/MM/YYYY", "error");
      return;
    }

    try {
      await invoke("crear_evento", {
        nombre,
        fecha,
        hora,
        descripcion,
        opcionRecordar,
      });
      showToast("Recordatorio creado exitosamente.", "success");
      (formEvento as HTMLFormElement).reset();
      cargarRecordatorios();
      renderCalendar(); // Actualizar puntitos
      cargarRecordatoriosHoy();
    } catch (err: any) {
      showToast(err.toString(), "error");
    }
  });

  const btnSelectRuta = document.getElementById("btn-select-ruta");
  btnSelectRuta?.addEventListener("click", async () => {
    const ruta = await seleccionarRuta(true);
    if (ruta) {
      (document.getElementById("apu-ruta") as HTMLInputElement).value = ruta;
    }
  });
}

function initTipTapEditor(): Editor | null {
  if (editorInstancia) return editorInstancia;
  try {
    const container = document.getElementById("tiptap-editor");
    if (container) {
      editorInstancia = new Editor({
        element: container,
        extensions: [
          CustomPasteExtension,
          StarterKit,
          TabExtension,
          Table.configure({ resizable: true }),
          TableRow,
          TableHeader,
          TableCell,
          Highlight.configure({ multicolor: true }),
          Image.configure({
            resize: {
              enabled: true,
              alwaysPreserveAspectRatio: true,
            },
          }),
          Markdown,
        ],
        content: "",
        onTransaction: () => {
          updateToolbarActiveStates();
        },
      });
      console.log("Tiptap Editor inicializado correctamente.");
    }
  } catch (e) {
    console.error("Error al inicializar Tiptap Editor:", e);
  }
  return editorInstancia;
}

function setupEditor() {
  console.log("Iniciando setupEditor (eventos)...");

  // Pre-inicializar TipTap en segundo plano para apertura inmediata de apuntes
  if ("requestIdleCallback" in window) {
    (window as any).requestIdleCallback(() => initTipTapEditor());
  } else {
    setTimeout(() => initTipTapEditor(), 100);
  }

  const btnCerrar = document.getElementById("btn-editor-cerrar");
  const btnGuardar = document.getElementById("btn-editor-guardar");
  const btnGuardarCerrar = document.getElementById("btn-editor-guardar-cerrar") as HTMLButtonElement | null;
  const btnToggleSidebar = document.getElementById("btn-toggle-sidebar");
  const btnExportarZip = document.getElementById("btn-editor-exportar-zip") as HTMLButtonElement | null;

  btnCerrar?.addEventListener("click", () => {
    cerrarEditor();
  });

  btnGuardar?.addEventListener("click", async () => {
    await guardarApunteActual();
  });

  btnGuardarCerrar?.addEventListener("click", async () => {
    const exito = await guardarApunteActual();
    if (exito) {
      if (currentEditSincronizarDrive && currentEditPath) {
        setButtonLoading(btnGuardarCerrar, true, "Subiendo a Drive…");
        actualizarIconoNubecita("syncing");
        try {
          await invoke("subir_apunte_drive", { pathApunte: currentEditPath });
          showToast("Apunte guardado y sincronizado en Google Drive", "success");
          actualizarIconoNubecita("synced");
        } catch (err: any) {
          console.error("Error al sincronizar con Drive:", err);
          showToast(`Guardado localmente. Error al sincronizar con Drive: ${err}`, "error");
          actualizarIconoNubecita(isGoogleDriveConnected ? "synced" : "unlinked");
        } finally {
          setButtonLoading(btnGuardarCerrar, false);
        }
      }
      cerrarEditor();
    }
  });

  const btnToggleDrive = document.getElementById("btn-editor-toggle-drive");
  btnToggleDrive?.addEventListener("click", async () => {
    if (currentEditCodigo === null) return;
    currentEditSincronizarDrive = !currentEditSincronizarDrive;
    actualizarToggleDriveUI(currentEditSincronizarDrive);
    try {
      await invoke("cambiar_sincronizar_drive", {
        codigoApunte: currentEditCodigo,
        sincronizar: currentEditSincronizarDrive,
      });
      showToast(
        `Sincronización con Drive ${currentEditSincronizarDrive ? "activada" : "desactivada"}`,
        "success",
      );
    } catch (e: any) {
      console.error("Error al cambiar sincronizar_drive:", e);
    }
  });

  // ── Atajo de teclado: Ctrl+S / Cmd+S para guardar ──────────────────────────
  window.addEventListener("keydown", async (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      // Solo activo mientras se edita un apunte
      if (!currentEditPath || !editorInstancia || currentEditCodigo === null)
        return;
      e.preventDefault();
      await guardarApunteActual();
    }
  });

  const btnExportarMenu = document.getElementById("btn-editor-exportar-menu");
  const dropdownContent = document.getElementById("exportar-dropdown-content");

  btnExportarMenu?.addEventListener("click", (e) => {
    e.stopPropagation();
    dropdownContent?.classList.toggle("show");
  });

  const btnTableMenu = document.getElementById("btn-table-menu");
  const tableDropdownContent = document.getElementById("table-dropdown-content");

  btnTableMenu?.addEventListener("click", (e) => {
    e.stopPropagation();
    tableDropdownContent?.classList.toggle("show");
  });

  // ── Table Grid Picker ────────────────────────────────────────────────────
  const btnInsertTable = document.getElementById("btn-insert-table");
  const tableGridPicker = document.getElementById("table-grid-picker");
  const tableGridCells = document.getElementById("table-grid-cells");
  const tableGridLabel = document.getElementById("table-grid-label");
  const GRID_COLS = 8;
  const GRID_ROWS = 8;

  // Build the 8×8 cell grid
  if (tableGridCells) {
    for (let r = 1; r <= GRID_ROWS; r++) {
      for (let c = 1; c <= GRID_COLS; c++) {
        const cell = document.createElement("div");
        cell.className = "table-grid-cell";
        cell.dataset.row = String(r);
        cell.dataset.col = String(c);
        tableGridCells.appendChild(cell);
      }
    }
  }

  function updateGridHighlight(rows: number, cols: number) {
    tableGridCells?.querySelectorAll(".table-grid-cell").forEach((el) => {
      const cell = el as HTMLElement;
      const r = Number(cell.dataset.row);
      const c = Number(cell.dataset.col);
      cell.classList.toggle("highlighted", r <= rows && c <= cols);
    });
    if (tableGridLabel) tableGridLabel.textContent = `${cols} × ${rows}`;
  }

  btnInsertTable?.addEventListener("click", (e) => {
    e.stopPropagation();
    tableGridPicker?.classList.toggle("show");
    if (tableGridPicker?.classList.contains("show")) {
      updateGridHighlight(1, 1);
    }
  });

  tableGridCells?.addEventListener("mouseover", (e) => {
    const cell = (e.target as HTMLElement).closest(".table-grid-cell") as HTMLElement | null;
    if (!cell) return;
    updateGridHighlight(Number(cell.dataset.row), Number(cell.dataset.col));
  });

  tableGridCells?.addEventListener("click", (e) => {
    const cell = (e.target as HTMLElement).closest(".table-grid-cell") as HTMLElement | null;
    if (!cell) return;
    const rows = Number(cell.dataset.row);
    const cols = Number(cell.dataset.col);
    tableGridPicker?.classList.remove("show");
    if (editorInstancia) {
      editorInstancia.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run();
    }
  });

  window.addEventListener("click", (e) => {
    if (!btnExportarMenu?.contains(e.target as Node)) {
      if (dropdownContent?.classList.contains("show")) {
        dropdownContent.classList.remove("show");
      }
    }
    if (!btnTableMenu?.contains(e.target as Node)) {
      if (tableDropdownContent?.classList.contains("show")) {
        tableDropdownContent.classList.remove("show");
      }
    }
    if (!btnInsertTable?.closest(".table-insert-wrapper")?.contains(e.target as Node)) {
      tableGridPicker?.classList.remove("show");
    }
  });

  // ── Exportar como ZIP ──────────────────────────────────────────────────────
  btnExportarZip?.addEventListener("click", async () => {
    if (!currentEditPath) {
      showToast("No hay ningún apunte abierto para exportar", "error");
      return;
    }

    // Guardar antes de exportar para capturar cambios y referencias
    await guardarApunteActual();

    try {
      setButtonLoading(btnExportarZip, true, "Exportando…");
      // Usar camelCase para que coincida con el resto del frontend (y con el mapeo de Tauri)
      const zipFileName = await invoke<string>("crear_zip", {
        pathApunte: currentEditPath,
      });

      const parentDir = getParentDirFromPath(currentEditPath);
      const zipFullPath = joinPath(parentDir, zipFileName);
      showToast(`Nota exportada correctamente: ${zipFullPath}`, "success");
    } catch (err: any) {
      console.error("Error al exportar ZIP:", err);
      showToast(`Exportación fallida: ${err?.toString?.() ?? String(err)}`, "error");
    } finally {
      setButtonLoading(btnExportarZip, false);
    }
  });

  // ── Exportar como PDF ──────────────────────────────────────────────────────
  const btnExportarPdf = document.getElementById("btn-editor-exportar-pdf") as HTMLButtonElement | null;
  btnExportarPdf?.addEventListener("click", async () => {
    if (!currentEditPath || !editorInstancia) {
      showToast("No hay ningún apunte abierto para exportar", "error");
      return;
    }

    await guardarApunteActual();

    btnExportarPdf.disabled = true;
    showToast("Generando PDF…", "success");

    // Overlay visual mientras se genera el PDF
    const overlay = document.createElement("div");
    overlay.style.cssText = [
      "position: fixed",
      "top: 0",
      "left: 0",
      "right: 0",
      "bottom: 0",
      "background: rgba(35, 32, 28, 0.75)",
      "z-index: 1000000",
      "display: flex",
      "flex-direction: column",
      "align-items: center",
      "justify-content: center",
      "color: #ffffff",
      "font-family: var(--font-sans)",
      "font-size: 1.1rem",
      "font-weight: 600",
      "gap: 0.8rem",
    ].join("; ");
    overlay.innerHTML = `
      <div style="width: 36px; height: 36px; border: 3px solid rgba(255,255,255,0.3); border-top-color: #ffffff; border-radius: 50%; animation: spinPdf 0.8s linear infinite;"></div>
      <div>Generando documento PDF…</div>
      <style>@keyframes spinPdf { to { transform: rotate(360deg); } }</style>
    `;
    document.body.appendChild(overlay);

    let container: HTMLElement | null = null;

    try {
      const editorEl = document.querySelector("#tiptap-editor .tiptap") as HTMLElement | null;
      if (!editorEl) throw new Error("No se encontró el elemento del editor");

      // 1. Clonar el contenido y convertir todas las imágenes a Base64
      const clone = editorEl.cloneNode(true) as HTMLElement;
      const imgOriginals = Array.from(editorEl.querySelectorAll("img")) as HTMLImageElement[];
      const imgClones = Array.from(clone.querySelectorAll("img")) as HTMLImageElement[];

      await Promise.all(
        imgOriginals.map(async (origImg, i) => {
          const cloneImg = imgClones[i];
          if (!cloneImg) return;
          try {
            cloneImg.src = await imgToDataUrl(origImg.src);
          } catch (e) {
            console.warn("No se pudo convertir imagen a base64:", origImg.src, e);
          }
        })
      );

      // 2. Crear contenedor temporal A4 (ancho 750px) sin padding interno duplicado
      container = document.createElement("div");
      container.style.cssText = [
        "position: absolute",
        "top: 0",
        "left: 0",
        "width: 750px",
        "background: #ffffff",
        "color: #1a1a1a",
        "font-family: 'Inter', system-ui, -apple-system, sans-serif",
        "font-size: 11pt",
        "line-height: 1.6",
        "padding: 0px",
        "margin: 0px",
        "box-sizing: border-box",
        "z-index: 999999",
        "pointer-events: none",
        "overflow: visible",
      ].join("; ");

      // Aplicar inline styles
      inlineEditorStyles(clone);

      container.appendChild(clone);
      document.body.appendChild(container);

      // Pequeña pausa para asegurar renderizado en el DOM
      await new Promise((r) => setTimeout(r, 150));

      const pdfPath = currentEditPath.replace(/\.md$/i, ".pdf");
      const fileName = pdfPath.split(/[\/\\]/).pop() ?? "apunte.pdf";

      // 3. Crear documento jsPDF en pt (A4 = 595.28 pt x 841.89 pt)
      const pdf = new jsPDF({
        orientation: "portrait",
        unit: "pt",
        format: "a4",
      });

      // Márgenes de 20pt en los 4 bordes. Ancho útil = 595.28 - 40 = 555.28 pt
      const marginPt = 20;
      const printWidthPt = 595.28 - marginPt * 2;

      await pdf.html(container, {
        x: 0,
        y: 0,
        width: printWidthPt,
        windowWidth: 750,
        autoPaging: "text",
        html2canvas: {
          scale: 0.74, // 555.28 / 750
          useCORS: true,
          allowTaint: true,
          backgroundColor: "#ffffff",
          logging: false,
        },
        margin: [marginPt, marginPt, marginPt, marginPt],
      });

      // 4. Obtener string Base64 del PDF generado
      const dataUri = pdf.output("datauristring");
      const base64Content = dataUri.split(",")[1] || "";

      if (!base64Content) {
        throw new Error("No se pudo generar el contenido Base64 del PDF");
      }

      // 5. Guardar en disco vía Tauri IPC
      await invoke("guardar_pdf", { path: pdfPath, contentBase64: base64Content });

      showToast(`PDF guardado con éxito: ${fileName}`, "success");
    } catch (err: any) {
      console.error("Error al exportar PDF:", err);
      showToast(`Error al exportar PDF: ${err.message || err}`, "error");
    } finally {
      if (container && document.body.contains(container)) {
        document.body.removeChild(container);
      }
      if (document.body.contains(overlay)) {
        document.body.removeChild(overlay);
      }
      btnExportarPdf.disabled = false;
    }
  });

  /**
   * Convierte cualquier URL de imagen a Data URL Base64 de forma infalible.
   */
  async function imgToDataUrl(src: string): Promise<string> {
    if (!src) return src;
    if (src.startsWith("data:")) return src;

    try {
      const response = await fetch(src);
      const blob = await response.blob();
      return new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = () => resolve(src);
        reader.readAsDataURL(blob);
      });
    } catch {
      return new Promise<string>((resolve) => {
        const img = document.createElement("img") as HTMLImageElement;
        img.crossOrigin = "anonymous";
        img.onload = () => {
          try {
            const canvas = document.createElement("canvas");
            canvas.width = img.naturalWidth || img.width || 300;
            canvas.height = img.naturalHeight || img.height || 150;
            const ctx = canvas.getContext("2d");
            if (!ctx) { resolve(src); return; }
            ctx.drawImage(img, 0, 0);
            resolve(canvas.toDataURL("image/png"));
          } catch {
            resolve(src);
          }
        };
        img.onerror = () => resolve(src);
        img.src = src;
      });
    }
  }

  /**
   * Aplica inline styles a los elementos clonados para asegurar fidelidad estética en PDF
   * e impedir que las imágenes o bloques desborden.
   */
  function inlineEditorStyles(root: HTMLElement): void {
    const FONT = "'Inter', system-ui, -apple-system, sans-serif";
    const COLOR_TEXT = "#2c2a29";
    const COLOR_ACCENT = "#2c4c3b";

    root.style.fontFamily = FONT;
    root.style.fontSize = "11pt";
    root.style.lineHeight = "1.6";
    root.style.color = COLOR_TEXT;
    root.style.background = "#ffffff";
    root.style.margin = "0px";
    root.style.padding = "0px";

    // Eliminar margen superior del primer elemento hijo para evitar espacio en blanco inicial
    const firstChild = root.firstElementChild as HTMLElement | null;
    if (firstChild) {
      firstChild.style.marginTop = "0px";
    }

    // Párrafos
    root.querySelectorAll("p").forEach((el) => {
      const h = el as HTMLElement;
      h.style.cssText += `; margin: 0 0 0.6em 0; font-family: ${FONT}; font-size: 11pt; color: ${COLOR_TEXT}; page-break-inside: avoid !important; break-inside: avoid !important;`;
    });

    // Títulos
    root.querySelectorAll("h1").forEach((el) => {
      const h = el as HTMLElement;
      h.style.cssText += `; font-family: ${FONT}; font-size: 20pt; font-weight: 700; color: ${COLOR_ACCENT}; margin: 1em 0 0.4em; line-height: 1.2; page-break-after: avoid !important; break-after: avoid !important; page-break-inside: avoid !important; break-inside: avoid !important;`;
    });
    root.querySelectorAll("h2").forEach((el) => {
      const h = el as HTMLElement;
      h.style.cssText += `; font-family: ${FONT}; font-size: 15pt; font-weight: 700; color: ${COLOR_ACCENT}; margin: 0.9em 0 0.35em; line-height: 1.25; page-break-after: avoid !important; break-after: avoid !important; page-break-inside: avoid !important; break-inside: avoid !important;`;
    });
    root.querySelectorAll("h3").forEach((el) => {
      const h = el as HTMLElement;
      h.style.cssText += `; font-family: ${FONT}; font-size: 12pt; font-weight: 700; color: ${COLOR_TEXT}; margin: 0.8em 0 0.3em; line-height: 1.3; page-break-after: avoid !important; break-after: avoid !important; page-break-inside: avoid !important; break-inside: avoid !important;`;
    });

    // Formato de texto
    root.querySelectorAll("strong, b").forEach((el) => {
      (el as HTMLElement).style.fontWeight = "700";
    });
    root.querySelectorAll("em, i").forEach((el) => {
      (el as HTMLElement).style.fontStyle = "italic";
    });
    root.querySelectorAll("s, del").forEach((el) => {
      (el as HTMLElement).style.textDecoration = "line-through";
    });

    // Resaltados (mark)
    root.querySelectorAll("mark").forEach((el) => {
      const markEl = el as HTMLElement;
      const existingBg = markEl.style.backgroundColor;
      const bg = existingBg && existingBg !== "" ? existingBg : "#fef08a";
      markEl.style.cssText += `; background-color: ${bg} !important; color: ${COLOR_TEXT}; border-radius: 2px; padding: 0.1em 0.2em; display: inline; box-decoration-break: clone; -webkit-box-decoration-break: clone;`;
    });

    // Bloques de código
    root.querySelectorAll("code").forEach((el) => {
      const codeEl = el as HTMLElement;
      if (codeEl.parentElement?.tagName !== "PRE") {
        codeEl.style.cssText += "; background: #f0ede6; color: #c0392b; padding: 0.1em 0.3em; border-radius: 3px; font-family: monospace; font-size: 0.9em;";
      }
    });
    root.querySelectorAll("pre").forEach((el) => {
      (el as HTMLElement).style.cssText += "; background: #f5f2ec; border: 1px solid #dcd7c8; border-radius: 4px; padding: 0.8em 1em; white-space: pre-wrap; word-break: break-all; font-family: monospace; font-size: 9pt; margin: 0.6em 0; page-break-inside: avoid !important; break-inside: avoid !important;";
    });

    // Citas
    root.querySelectorAll("blockquote").forEach((el) => {
      (el as HTMLElement).style.cssText += `; border-left: 3px solid ${COLOR_ACCENT}; margin: 0.6em 0; padding: 0.3em 0.8em; color: #555555; background: #f9f8f4; page-break-inside: avoid !important; break-inside: avoid !important;`;
    });

    // Listas
    root.querySelectorAll("ul, ol").forEach((el) => {
      (el as HTMLElement).style.cssText += "; margin: 0.4em 0 0.4em 1.4em; padding: 0;";
    });
    root.querySelectorAll("li").forEach((el) => {
      (el as HTMLElement).style.cssText += `; margin: 0.15em 0; font-family: ${FONT}; font-size: 11pt; page-break-inside: avoid !important; break-inside: avoid !important;`;
    });

    // Imágenes: Evitar cortes e impedir desbordamientos
    root.querySelectorAll("img").forEach((el) => {
      const imgEl = el as HTMLElement;
      imgEl.style.cssText += "; max-width: 100% !important; height: auto !important; display: block; margin: 0.8em auto; page-break-inside: avoid !important; break-inside: avoid !important;";
    });
  }

  btnToggleSidebar?.addEventListener("click", () => {
    const container = document.querySelector(".app-container");
    if (!container) return;

    if (window.innerWidth <= 960) {
      container.classList.toggle("sidebar-visible");
      container.classList.remove("sidebar-collapsed");
    } else {
      container.classList.toggle("sidebar-collapsed");
      container.classList.remove("sidebar-visible");
    }
  });

  // Connect toolbar buttons
  const toolbar = document.getElementById("editor-toolbar");
  if (toolbar) {
    const buttons = toolbar.querySelectorAll(".toolbar-btn");
    buttons.forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        if (!editorInstancia) return;
        const command = btn.getAttribute("data-command");
        if (!command) return;

        let chain = editorInstancia.chain().focus();

        switch (command) {
          case "bold":
            chain.toggleBold().run();
            break;
          case "italic":
            chain.toggleItalic().run();
            break;
          case "strike":
            chain.toggleStrike().run();
            break;
          case "code":
            chain.toggleCode().run();
            break;
          case "highlight":
            chain.toggleHighlight({ color: selectedHighlightColor }).run();
            break;
          case "h1":
            chain.toggleHeading({ level: 1 }).run();
            break;
          case "h2":
            chain.toggleHeading({ level: 2 }).run();
            break;
          case "h3":
            chain.toggleHeading({ level: 3 }).run();
            break;
          case "paragraph":
            chain.setParagraph().run();
            break;
          case "bulletList":
            chain.toggleBulletList().run();
            break;
          case "orderedList":
            chain.toggleOrderedList().run();
            break;
          case "blockquote":
            chain.toggleBlockquote().run();
            break;
          // insertTable is handled by the grid picker (btn-insert-table)
          case "addColumnBefore":
            chain.addColumnBefore().run();
            break;
          case "addColumnAfter":
            chain.addColumnAfter().run();
            break;
          case "deleteColumn":
            chain.deleteColumn().run();
            break;
          case "addRowBefore":
            chain.addRowBefore().run();
            break;
          case "addRowAfter":
            chain.addRowAfter().run();
            break;
          case "deleteRow":
            chain.deleteRow().run();
            break;
          case "deleteTable":
            chain.deleteTable().run();
            break;
          case "image":
            (async () => {
              try {
                const path = await seleccionarRuta(false);
                if (!path) return;

                const rutaRelativa = await invoke<string>(
                  "incorporar_imagenes",
                  {
                    rutaImg: path,
                    rutaApunte: currentEditPath,
                  },
                );

                const lastSlash = Math.max(
                  currentEditPath.lastIndexOf("/"),
                  currentEditPath.lastIndexOf("\\"),
                );
                const parentDir =
                  lastSlash !== -1
                    ? currentEditPath.substring(0, lastSlash)
                    : "";
                const absolutePath = parentDir
                  ? `${parentDir}/${rutaRelativa}`
                  : rutaRelativa;

                const assetUrl = convertFileSrc(absolutePath);

                editorInstancia
                  .chain()
                  .focus()
                  .setImage({ src: assetUrl })
                  .run();
                showToast("Imagen agregada correctamente", "success");
              } catch (error: any) {
                console.error("Error al insertar imagen:", error);
                showToast(`Error al insertar imagen: ${error}`, "error");
              }
            })();
            break;
          case "horizontalRule":
            chain.setHorizontalRule().run();
            break;
          case "undo":
            chain.undo().run();
            break;
          case "redo":
            chain.redo().run();
            break;
        }
      });
    });

    const swatches = toolbar.querySelectorAll(".color-swatch");
    swatches.forEach((swatch) => {
      swatch.addEventListener("click", (e) => {
        e.preventDefault();
        if (!editorInstancia) return;
        const color = swatch.getAttribute("data-color");
        if (color) {
          selectedHighlightColor = color;
          editorInstancia.chain().focus().setHighlight({ color }).run();
          updateToolbarActiveStates();
        }
      });
    });
  }
}

function updateToolbarActiveStates() {
  const editor = editorInstancia;
  if (!editor) return;
  const toolbar = document.getElementById("editor-toolbar");
  if (!toolbar) return;

  const buttons = toolbar.querySelectorAll(".toolbar-btn");
  buttons.forEach((btn) => {
    const command = btn.getAttribute("data-command");
    if (!command) return;

    let isActive = false;
    switch (command) {
      case "bold":
        isActive = editor.isActive("bold");
        break;
      case "italic":
        isActive = editor.isActive("italic");
        break;
      case "strike":
        isActive = editor.isActive("strike");
        break;
      case "code":
        isActive = editor.isActive("code");
        break;
      case "highlight":
        isActive = editor.isActive("highlight");
        break;
      case "h1":
        isActive = editor.isActive("heading", { level: 1 });
        break;
      case "h2":
        isActive = editor.isActive("heading", { level: 2 });
        break;
      case "h3":
        isActive = editor.isActive("heading", { level: 3 });
        break;
      case "paragraph":
        isActive = editor.isActive("paragraph");
        break;
      case "bulletList":
        isActive = editor.isActive("bulletList");
        break;
      case "orderedList":
        isActive = editor.isActive("orderedList");
        break;
      case "blockquote":
        isActive = editor.isActive("blockquote");
        break;
    }

    if (isActive) {
      btn.classList.add("is-active");
    } else {
      btn.classList.remove("is-active");
    }
  });

  // Update selected highlight color swatch styling
  const isHighlightActive = editor.isActive("highlight");
  const highlightAttrs = editor.getAttributes("highlight");
  let currentColor = selectedHighlightColor;
  if (isHighlightActive && highlightAttrs && highlightAttrs.color) {
    currentColor = highlightAttrs.color;
  }

  const swatches = toolbar.querySelectorAll(".color-swatch");
  swatches.forEach((swatch) => {
    const color = swatch.getAttribute("data-color");
    if (color === currentColor) {
      swatch.classList.add("is-selected");
    } else {
      swatch.classList.remove("is-selected");
    }
  });
}

function cerrarEditor() {
  currentEditPath = "";
  currentEditCodigo = null;
  currentEditSincronizarDrive = false;
  actualizarToggleDriveUI(false);
  if (editorInstancia) {
    editorInstancia.commands.setContent("");
  }

  const appContainer = document.querySelector(".app-container");
  if (appContainer) {
    appContainer.classList.remove("editor-mode");
    appContainer.classList.remove("sidebar-collapsed");
    appContainer.classList.remove("sidebar-visible");
  }

  const views = document.querySelectorAll(".view");
  views.forEach((v) => v.classList.remove("active"));
  document.getElementById("view-materias")?.classList.add("active");

  const titleEl = document.getElementById("view-title");
  if (titleEl) {
    titleEl.textContent = "Materias";
    titleEl.style.display = "none";
  }

  const topbarTabs = document.getElementById("topbar-tabs");
  if (topbarTabs) {
    topbarTabs.style.display = "flex";
    document
      .querySelectorAll(".topbar-tab")
      .forEach((t) => t.classList.remove("active"));
    document
      .querySelector(".topbar-tab[data-tab-target='view-materias']")
      ?.classList.add("active");
  }

  const navBtns = document.querySelectorAll(".nav-btn");
  navBtns.forEach((b) => {
    b.classList.remove("active");
    if (b.getAttribute("data-target") === "view-materias") {
      b.classList.add("active");
    }
  });

  cargarMaterias();
  cargarRecordatoriosHoy();
}

async function guardarApunteActual(): Promise<boolean> {
  if (!currentEditPath || !editorInstancia || currentEditCodigo === null)
    return false;
  try {
    const htmlContent = editorInstancia.getHTML();

    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlContent, "text/html");
    const imgs = doc.querySelectorAll("img");
    imgs.forEach((img) => {
      const src = img.getAttribute("src");
      if (src) {
        img.setAttribute("src", recortarRutaRecursos(src));
      }
    });
    const finalHtml = doc.body.innerHTML;

    const content = turndownService.turndown(finalHtml);

    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const hours = String(now.getHours()).padStart(2, "0");
    const minutes = String(now.getMinutes()).padStart(2, "0");
    const fechaModif = `${year}-${month}-${day} ${hours}:${minutes}`;

    await invoke("guardar_apunte", {
      path: currentEditPath,
      content,
      apunteCodigo: currentEditCodigo.toString(),
      fechaModif: fechaModif,
    });
    showToast("Apunte guardado correctamente", "success");
    cargarUltimosModificados();
    return true;
  } catch (error: any) {
    showToast(`Error al guardar: ${error}`, "error");
    return false;
  }
}

function setupModal() {
  const modal = document.getElementById("modal-apunte");
  const closeModalBtn = document.getElementById("close-modal");
  const formModalApunte = document.getElementById("form-modal-apunte");

  const modalVerApuntes = document.getElementById("modal-ver-apuntes");
  const closeModalVerApuntesBtn = document.getElementById(
    "close-modal-ver-apuntes",
  );

  if (modal && closeModalBtn) {
    closeModalBtn.addEventListener("click", () => {
      modal.classList.remove("active");
    });

    // Close when clicking outside
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        modal.classList.remove("active");
      }
    });
  }

  if (modalVerApuntes && closeModalVerApuntesBtn) {
    closeModalVerApuntesBtn.addEventListener("click", () => {
      modalVerApuntes.classList.remove("active");
    });

    modalVerApuntes.addEventListener("click", (e) => {
      if (e.target === modalVerApuntes) {
        modalVerApuntes.classList.remove("active");
      }
    });
  }

  const modalConfirmDeleteMateria = document.getElementById(
    "modal-confirm-delete-materia",
  );
  const btnCancelDeleteMateria = document.getElementById(
    "btn-cancel-delete-materia",
  );
  const btnConfirmDeleteMateria = document.getElementById(
    "btn-confirm-delete-materia",
  );

  if (
    modalConfirmDeleteMateria &&
    btnCancelDeleteMateria &&
    btnConfirmDeleteMateria
  ) {
    btnCancelDeleteMateria.addEventListener("click", () => {
      modalConfirmDeleteMateria.classList.remove("active");
      materiaToDelete = null;
    });

    btnConfirmDeleteMateria.addEventListener("click", async () => {
      if (materiaToDelete) {
        try {
          await invoke("borrar_materia", { codigoMateria: materiaToDelete });
          showToast("Materia borrada exitosamente.", "success");
          cargarMaterias();
          cargarUltimosModificados(); // Por si se borraron apuntes recientes
          cargarSelectorMaterias(); // Actualizar selector
        } catch (err: any) {
          showToast(err.toString(), "error");
        } finally {
          modalConfirmDeleteMateria.classList.remove("active");
          materiaToDelete = null;
        }
      }
    });

    modalConfirmDeleteMateria.addEventListener("click", (e) => {
      if (e.target === modalConfirmDeleteMateria) {
        modalConfirmDeleteMateria.classList.remove("active");
        materiaToDelete = null;
      }
    });
  }

  formModalApunte?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const tema = (document.getElementById("modal-apu-tema") as HTMLInputElement)
      .value;
    const materiaCodigo = (
      document.getElementById("modal-apu-materia") as HTMLInputElement
    ).value;

    // Auto-generate current date for creation
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const hours = String(now.getHours()).padStart(2, "0");
    const minutes = String(now.getMinutes()).padStart(2, "0");
    const fechaCreacion = `${year}-${month}-${day} ${hours}:${minutes}`;

    const ruta = (document.getElementById("modal-apu-ruta") as HTMLInputElement)
      .value;

    if (!materiaCodigo) {
      showToast("Error: Código de materia faltante", "error");
      return;
    }

    try {
      const resp = await invoke<Apunte>("crear_apunte", {
        tema,
        materiaCodigo,
        fechaCreacion,
        ultModificacion: fechaCreacion,
        ruta,
      });
      showToast("Apunte registrado exitosamente.", "success");
      (formModalApunte as HTMLFormElement).reset();
      modal?.classList.remove("active");
      cargarUltimosModificados();
      await abrirEditor(resp);
    } catch (err: any) {
      showToast(err.toString(), "error");
    }
  });

  const btnModalSelectRuta = document.getElementById("btn-modal-select-ruta");
  btnModalSelectRuta?.addEventListener("click", async () => {
    const ruta = await seleccionarRuta(true);
    if (ruta) {
      (document.getElementById("modal-apu-ruta") as HTMLInputElement).value =
        ruta;
    }
  });
}

async function cargarMaterias() {
  const container = document.getElementById("materias-list");
  if (!container) return;

  container.innerHTML = `<p style="color:var(--text-secondary)">Cargando materias...</p>`;

  try {
    materiasCache = await invoke<Materia[]>("mostrar_materias");

    if (materiasCache.length === 0) {
      container.innerHTML = `
        <div style="text-align:center; padding: 3rem; color:var(--text-secondary); width: 100%; grid-column: 1/-1;">
          <p style="margin-bottom: 1.5rem; font-size: 1.1rem;">No tenes materias registradas aún.</p>
          <button class="btn-primary" onclick="document.querySelector('[data-target=\\'view-nueva-materia\\']')?.click()" style="margin: 0 auto;">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M5 12h14"/><path d="M12 5v14"/>
            </svg>
            Cargar Nueva Materia
          </button>
        </div>
      `;
      return;
    }

    container.innerHTML = "";
    materiasCache.forEach((mat) => {
      const card = document.createElement("div");
      card.className = "materia-card glass-panel";

      const badgeAnual = mat.anual
        ? `<span class="badge anual">Anual</span>`
        : `<span class="badge cuatrimestral">Cuatrimestral</span>`;

      const cuatrimestreHtml = mat.anual
        ? ""
        : `<div style="font-size:0.85rem; color:var(--text-secondary)">Cuatrimestre: <strong style="color:var(--text-primary)">${mat.cuatrimestre}</strong></div>`;

      card.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:start">
          <span class="badge" style="background:rgba(255,255,255,0.05)">#${mat.codigo}</span>
          ${badgeAnual}
        </div>
        <h4>${mat.nombre}</h4>
        <div style="display:flex; gap:1rem; margin-top: auto; padding-top: 1rem;">
          <div style="font-size:0.85rem; color:var(--text-secondary)">Año: <strong style="color:var(--text-primary)">${mat.ano}</strong></div>
          ${cuatrimestreHtml}
        </div>
      `;

      const btnGroup = document.createElement("div");
      btnGroup.style.display = "flex";
      btnGroup.style.gap = "0.5rem";
      btnGroup.style.marginTop = "1rem";

      const btnAddApunte = document.createElement("button");
      btnAddApunte.className = "btn-secondary";
      btnAddApunte.style.flex = "1";
      btnAddApunte.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
        Agregar Apunte
      `;

      btnAddApunte.onclick = (e) => {
        e.stopPropagation();
        const modal = document.getElementById("modal-apunte");
        const modalMateriaId = document.getElementById(
          "modal-apu-materia",
        ) as HTMLInputElement;
        const modalMateriaNombre = document.getElementById(
          "modal-materia-nombre",
        );
        if (modal && modalMateriaId && modalMateriaNombre) {
          modalMateriaId.value = mat.codigo.toString();
          modalMateriaNombre.textContent = `Materia: ${mat.nombre}`;
          modal.classList.add("active");
        }
      };

      const btnBorrarMateria = document.createElement("button");
      btnBorrarMateria.className = "btn-secondary";
      btnBorrarMateria.style.padding = "0.4rem";
      btnBorrarMateria.style.color = "var(--error)";
      btnBorrarMateria.style.borderColor = "rgba(255, 99, 132, 0.3)";
      btnBorrarMateria.title = "Borrar Materia";
      btnBorrarMateria.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
      `;

      btnBorrarMateria.onclick = (e) => {
        e.stopPropagation();
        materiaToDelete = mat.codigo.toString();
        const modalConfirmDelete = document.getElementById(
          "modal-confirm-delete-materia",
        );
        if (modalConfirmDelete) modalConfirmDelete.classList.add("active");
      };

      btnGroup.appendChild(btnAddApunte);
      btnGroup.appendChild(btnBorrarMateria);

      card.appendChild(btnGroup);

      // Hacer la tarjeta clickeable para ver apuntes
      card.style.cursor = "pointer";
      card.onclick = () => abrirModalVerApuntes(mat);

      container.appendChild(card);
    });
  } catch (err: any) {
    container.innerHTML = `<p style="color:var(--error)">Error: ${err}</p>`;
    showToast(err.toString(), "error");
  }
}

async function abrirModalVerApuntes(mat: Materia) {
  currentMateriaForModal = mat;
  const modal = document.getElementById("modal-ver-apuntes");
  const modalMateriaNombre = document.getElementById(
    "modal-ver-apuntes-materia-nombre",
  );
  const listaContenedor = document.getElementById("modal-ver-apuntes-lista");

  if (!modal || !modalMateriaNombre || !listaContenedor) return;

  modalMateriaNombre.textContent = `Materia: ${mat.nombre}`;
  listaContenedor.innerHTML = `<p style="color:var(--text-secondary); text-align: center; padding: 2rem;">Cargando apuntes...</p>`;
  modal.classList.add("active");

  try {
    const apuntes = await invoke<Apunte[]>("buscar_apunt_materia", {
      materiaCodigo: mat.codigo.toString(),
    });

    if (apuntes.length === 0) {
      listaContenedor.innerHTML = `<p style="color:var(--text-secondary); text-align: center; padding: 2rem;">Todavía no tiene apuntes registrados.</p>`;
      return;
    }

    listaContenedor.innerHTML = "";
    apuntes.forEach((apunte) => {
      const item = document.createElement("div");
      item.className = "recent-note-item";
      item.style.cursor = "default";
      item.style.padding = "1rem";

      const [datePart, timePart] = apunte.ult_modificacion.split(" ");
      let formattedDate = apunte.ult_modificacion;
      if (datePart && timePart) {
        const dateParts = datePart.split("-");
        if (dateParts.length === 3) {
          formattedDate = `${dateParts[2]}/${dateParts[1]}/${dateParts[0]} ${timePart}`;
        }
      } else {
        const dateParts = apunte.ult_modificacion.split("-");
        if (dateParts.length === 3) {
          formattedDate = `${dateParts[2]}/${dateParts[1]}/${dateParts[0]}`;
        }
      }

      item.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <span class="recent-note-tema" title="${apunte.tema}" style="font-weight:600; font-size:1rem; color:var(--text-primary);">${apunte.tema}</span>
          <span class="recent-note-fecha">${formattedDate}</span>
        </div>
      `;

      const rutaDiv = document.createElement("div");
      rutaDiv.style.cssText =
        "display:flex; justify-content:space-between; align-items:center; margin-top:0.5rem; gap: 1rem;";

      const rutaSpan = document.createElement("div");
      rutaSpan.style.cssText =
        "font-size:0.85rem; color:var(--text-secondary); word-break:break-all; display:flex; align-items:center; gap:0.4rem;";
      rutaSpan.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>
          ${apunte.ruta}`;

      const btnAbrir = document.createElement("button");
      btnAbrir.className = "btn-secondary";
      btnAbrir.style.cssText =
        "padding: 0.3rem 0.8rem; font-size: 0.8rem; width: fit-content; white-space: nowrap;";
      btnAbrir.textContent = "Abrir";
      btnAbrir.onclick = async () => {
        await abrirEditor(apunte);
      };

      const btnBorrar = document.createElement("button");
      btnBorrar.className = "btn-secondary";
      btnBorrar.style.cssText =
        "padding: 0.3rem; font-size: 0.8rem; width: fit-content; color: var(--error); border-color: rgba(255, 99, 132, 0.3);";
      btnBorrar.title = "Borrar Apunte";
      btnBorrar.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`;
      btnBorrar.onclick = async (e) => {
        e.stopPropagation();
        const userConfirmed = await confirm(
          `¿Estás seguro de que deseas borrar el apunte "${apunte.tema}"?`,
          { title: "Borrar Apunte", kind: "warning" },
        );
        if (userConfirmed) {
          try {
            await invoke("borrar_apunte", {
              codigoApunte: apunte.codigo_apunte.toString(),
              ruta: apunte.ruta,
            });
            showToast("Apunte borrado exitosamente.", "success");
            abrirModalVerApuntes(mat);
            cargarUltimosModificados();
          } catch (err: any) {
            showToast(err.toString(), "error");
          }
        }
      };

      const accionesDiv = document.createElement("div");
      accionesDiv.style.display = "flex";
      accionesDiv.style.gap = "0.5rem";
      accionesDiv.appendChild(btnAbrir);
      accionesDiv.appendChild(btnBorrar);

      rutaDiv.appendChild(rutaSpan);
      rutaDiv.appendChild(accionesDiv);

      item.appendChild(rutaDiv);
      listaContenedor.appendChild(item);
    });
  } catch (err: any) {
    listaContenedor.innerHTML = `<p style="color:var(--error); text-align: center; padding: 2rem;">Error al buscar apuntes: ${err}</p>`;
    showToast(err.toString(), "error");
  }
}

async function fetchEventos(
  fechaInicio: string,
  fechaFin: string,
): Promise<Evento[]> {
  let allEvents: Evento[] = [];
  let offset = 0;
  while (true) {
    const batch = await invoke<Evento[]>("mostrar_eventos", {
      offset,
      fechaInicio,
      fechaFin,
    });
    allEvents.push(...batch);
    if (batch.length < 5) break;
    offset += 5;
  }
  return allEvents;
}

function getFormattedDateString(date: Date, endOfDay = false): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const time = endOfDay ? "23:59" : "00:00";
  return `${y}/${m}/${d} ${time}`;
}

async function cargarRecordatorios(fechaFiltro?: string) {
  const listaContenedor = document.getElementById("view-recordatorios-lista");

  if (!listaContenedor) return;

  listaContenedor.innerHTML = `<p style="color:var(--text-secondary); text-align: center; padding: 2rem;">Cargando eventos...</p>`;

  const renderSection = (title: string, eventos: Evento[]) => {
    if (eventos.length === 0) return;

    const secTitle = document.createElement("h4");
    secTitle.style.cssText =
      "font-family: var(--font-serif); font-size: 0.95rem; color: var(--accent); margin: 1rem 0 0.5rem 0; border-bottom: 1px solid var(--panel-border); padding-bottom: 0.2rem;";
    secTitle.textContent = title;
    listaContenedor.appendChild(secTitle);

    eventos.forEach((evento) => {
      const item = document.createElement("div");
      item.className = "recent-note-item";
      item.style.cursor = "default";
      item.style.padding = "0.8rem 0.5rem";

      const timeStr = evento.hora ? ` a las ${evento.hora}` : "";
      const fParts = evento.fecha.split("/");
      let displayDate = evento.fecha;
      if (fParts.length === 3) {
        displayDate = `${fParts[2]}/${fParts[1]}/${fParts[0]}`;
      }

      item.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <span class="recent-note-tema" title="${evento.nombre}" style="font-weight:600; font-size:1rem; color:var(--text-primary);">${evento.nombre}</span>
          <span class="recent-note-fecha">${displayDate}${timeStr}</span>
        </div>
      `;

      if (evento.descripcion) {
        const descDiv = document.createElement("div");
        descDiv.style.cssText =
          "font-size:0.85rem; color:var(--text-secondary); margin-top:0.4rem;";
        descDiv.textContent = evento.descripcion;
        item.appendChild(descDiv);
      }

      const accionesDiv = document.createElement("div");
      accionesDiv.style.display = "flex";
      accionesDiv.style.justifyContent = "flex-end";
      accionesDiv.style.marginTop = "0.5rem";

      const btnBorrar = document.createElement("button");
      btnBorrar.className = "btn-secondary";
      btnBorrar.style.cssText =
        "padding: 0.3rem; font-size: 0.8rem; width: fit-content; color: var(--error); border-color: rgba(255, 99, 132, 0.3);";
      btnBorrar.title = "Borrar Recordatorio";
      btnBorrar.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg> Borrar`;
      btnBorrar.onclick = async (e) => {
        e.stopPropagation();
        const userConfirmed = await confirm(
          `¿Estás seguro de que deseas borrar el recordatorio "${evento.nombre}"?`,
          { title: "Borrar Recordatorio", kind: "warning" },
        );
        if (userConfirmed) {
          try {
            await invoke("borrar_evento", {
              codigoEvento: evento.codigo_evento.toString(),
            });
            showToast("Recordatorio borrado exitosamente.", "success");
            cargarRecordatorios(fechaFiltro);
            renderCalendar();
            cargarRecordatoriosHoy();
          } catch (err: any) {
            showToast(err.toString(), "error");
          }
        }
      };
      accionesDiv.appendChild(btnBorrar);
      item.appendChild(accionesDiv);

      listaContenedor.appendChild(item);
    });
  };

  try {
    if (typeof fechaFiltro === "string" && fechaFiltro.trim() !== "") {
      const fInicio = fechaFiltro + " 00:00";
      const fFin = fechaFiltro + " 23:59";
      const eventosDia = await fetchEventos(fInicio, fFin);

      listaContenedor.innerHTML = "";

      const btnClear = document.createElement("button");
      btnClear.className = "btn-secondary";
      btnClear.style.cssText =
        "margin-bottom: 1rem; width: 100%; display: flex; justify-content: center; gap: 0.5rem; align-items: center;";
      btnClear.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg> Volver a todos los eventos`;
      btnClear.onclick = () => cargarRecordatorios();
      listaContenedor.appendChild(btnClear);

      if (eventosDia.length === 0) {
        const p = document.createElement("p");
        p.style.cssText =
          "color:var(--text-secondary); text-align: center; padding: 2rem;";
        const parts = fechaFiltro.split("/");
        p.textContent = `No hay eventos programados para el ${parts[2]}/${parts[1]}/${parts[0]}.`;
        listaContenedor.appendChild(p);
      } else {
        const parts = fechaFiltro.split("/");
        renderSection(
          `Eventos del ${parts[2]}/${parts[1]}/${parts[0]}`,
          eventosDia,
        );
      }
      return;
    }

    const today = new Date();

    const hInicio = getFormattedDateString(today, false);
    const hFin = getFormattedDateString(today, true);

    const d1 = new Date(today);
    d1.setDate(d1.getDate() + 1);
    const d7 = new Date(today);
    d7.setDate(d7.getDate() + 7);
    const pInicio = getFormattedDateString(d1, false);
    const pFin = getFormattedDateString(d7, true);

    const d8 = new Date(today);
    d8.setDate(d8.getDate() + 8);
    const dLast = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    const mInicio = getFormattedDateString(d8, false);
    const mFin = getFormattedDateString(dLast, true);

    const recordatoriosProgramados = await invoke<Evento[]>("eventos_hoy", {
      fechaInicio: hInicio,
      fechaFin: hFin,
    });

    let eventosHoy = await fetchEventos(hInicio, hFin);
    let eventos7dias = await fetchEventos(pInicio, pFin);

    let eventosMes: Evento[] = [];
    if (d8.getMonth() === today.getMonth()) {
      eventosMes = await fetchEventos(mInicio, mFin);
    }

    const removeRecordatorios = (eventos: Evento[]) => {
      return eventos.filter((ev) => {
        return !recordatoriosProgramados.some(
          (r) => r.codigo_evento === ev.codigo_evento,
        );
      });
    };

    eventosHoy = removeRecordatorios(eventosHoy);
    eventos7dias = removeRecordatorios(eventos7dias);
    eventosMes = removeRecordatorios(eventosMes);

    if (
      recordatoriosProgramados.length === 0 &&
      eventosHoy.length === 0 &&
      eventos7dias.length === 0 &&
      eventosMes.length === 0
    ) {
      listaContenedor.innerHTML = `<p style="color:var(--text-secondary); text-align: center; padding: 2rem;">No hay eventos programados.</p>`;
      return;
    }

    listaContenedor.innerHTML = "";

    renderSection("Recordatorios programados", recordatoriosProgramados);
    renderSection("Hoy", eventosHoy);
    renderSection("Próximos 7 días", eventos7dias);
    renderSection("En el mes", eventosMes);
  } catch (err: any) {
    listaContenedor.innerHTML = `<p style="color:var(--error); text-align: center; padding: 2rem;">Error al cargar eventos: ${err}</p>`;
    showToast(err.toString(), "error");
  }
}

async function cargarRecordatoriosHoy() {
  const panel = document.getElementById("today-reminders-panel");
  const listContenedor = document.getElementById("today-reminders-list");
  const countBadge = document.getElementById("today-reminders-count");
  const mainContent = document.querySelector(".main-content");

  if (!panel || !listContenedor || !countBadge || !mainContent) return;

  const editorView = document.getElementById("view-editor-apunte");
  const isEditorActive = editorView?.classList.contains("active");

  if (isEditorActive) {
    panel.style.display = "none";
    mainContent.classList.remove("has-reminders");
    return;
  }

  try {
    const today = new Date();
    const fInicio = getFormattedDateString(today, false);
    const fFin = getFormattedDateString(today, true);

    const recordatoriosHoy = await invoke<Evento[]>("eventos_hoy", {
      fechaInicio: fInicio,
      fechaFin: fFin,
    });

    if (recordatoriosHoy.length === 0) {
      panel.style.display = "none";
      mainContent.classList.remove("has-reminders");
      return;
    }

    panel.style.display = "flex";
    mainContent.classList.add("has-reminders");
    countBadge.textContent = recordatoriosHoy.length.toString();

    listContenedor.innerHTML = "";
    recordatoriosHoy.forEach((evento) => {
      const card = document.createElement("div");
      card.className = "today-reminder-item";

      const timeStr = evento.hora ? ` a las ${evento.hora}` : "";
      const fParts = evento.fecha.split("/");
      let displayDate = evento.fecha;
      if (fParts.length === 3) {
        displayDate = `${fParts[2]}/${fParts[1]}/${fParts[0]}`;
      }

      card.innerHTML = `
        <div class="today-reminder-title">${evento.nombre}</div>
        <div class="today-reminder-time">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/>
          </svg>
          ${displayDate}${timeStr}
        </div>
      `;

      if (evento.descripcion) {
        const descDiv = document.createElement("div");
        descDiv.className = "today-reminder-desc";
        descDiv.textContent = evento.descripcion;
        card.appendChild(descDiv);
      }

      listContenedor.appendChild(card);
    });
  } catch (err) {
    console.error("Error loading today's reminders:", err);
    panel.style.display = "none";
    mainContent.classList.remove("has-reminders");
  }
}

async function cargarSelectorMaterias() {
  const select = document.getElementById("apu-materia") as HTMLSelectElement;
  if (!select) return;

  try {
    materiasCache = await invoke<Materia[]>("mostrar_materias");

    select.innerHTML = `<option value="" disabled selected>Selecciona una materia...</option>`;

    if (materiasCache.length === 0) {
      select.innerHTML += `<option value="" disabled>-- No hay materias registradas --</option>`;
      return;
    }

    materiasCache.forEach((mat) => {
      const option = document.createElement("option");
      option.value = mat.codigo.toString();
      option.textContent = `${mat.nombre} (Año ${mat.ano})`;
      select.appendChild(option);
    });
  } catch (err) {
    console.error("Error cargando materias para el selector", err);
  }
}

function showToast(message: string, type: "success" | "error" = "success") {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;

  const icon =
    type === "success"
      ? `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/></svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;

  toast.innerHTML = `${icon} <span>${message}</span>`;
  container.appendChild(toast);

  // Remove after 3 seconds
  setTimeout(() => {
    toast.style.animation = "slideOut 0.3s ease forwards";
    setTimeout(() => {
      container.removeChild(toast);
    }, 300);
  }, 3000);
}

// Calendar Logic
function setupCalendar() {
  const prevBtn = document.getElementById("prev-month");
  const nextBtn = document.getElementById("next-month");

  if (prevBtn) {
    prevBtn.addEventListener("click", () => {
      currentCalendarDate.setMonth(currentCalendarDate.getMonth() - 1);
      renderCalendar();
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener("click", () => {
      currentCalendarDate.setMonth(currentCalendarDate.getMonth() + 1);
      renderCalendar();
    });
  }

  renderCalendar();
}

async function renderCalendar() {
  const monthYearStr = document.getElementById("calendar-month-year");
  const datesGrid = document.getElementById("calendar-dates");

  if (!monthYearStr || !datesGrid) return;

  const year = currentCalendarDate.getFullYear();
  const month = currentCalendarDate.getMonth();

  const monthNames = [
    "Enero",
    "Febrero",
    "Marzo",
    "Abril",
    "Mayo",
    "Junio",
    "Julio",
    "Agosto",
    "Septiembre",
    "Octubre",
    "Noviembre",
    "Diciembre",
  ];
  monthYearStr.textContent = `${monthNames[month]} ${year}`;

  datesGrid.innerHTML = "";

  const firstDay = new Date(year, month, 1).getDay(); // 0 is Sunday
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const prevMonthDays = new Date(year, month, 0).getDate();

  const today = new Date();

  try {
    const firstDayDate = new Date(year, month, 1);
    const lastDayDate = new Date(year, month + 1, 0);
    const fechaInicio = getFormattedDateString(firstDayDate);
    const fechaFin = getFormattedDateString(lastDayDate, true);

    eventosCache = await fetchEventos(fechaInicio, fechaFin);
  } catch (err) {
    console.error("Error fetching eventos:", err);
  }

  // Previous month dates
  for (let i = firstDay - 1; i >= 0; i--) {
    const dateEl = document.createElement("div");
    dateEl.className = "calendar-date other-month";
    dateEl.textContent = (prevMonthDays - i).toString();
    datesGrid.appendChild(dateEl);
  }

  // Current month dates
  for (let i = 1; i <= daysInMonth; i++) {
    const dateEl = document.createElement("div");
    dateEl.className = "calendar-date current-month";

    if (
      year === today.getFullYear() &&
      month === today.getMonth() &&
      i === today.getDate()
    ) {
      dateEl.classList.add("today");
    }

    const dayStr = String(i).padStart(2, "0");
    const monthStr = String(month + 1).padStart(2, "0");
    const dateStr = `${year}/${monthStr}/${dayStr}`;

    const hasEvent = eventosCache.some((ev) => ev.fecha === dateStr);

    dateEl.textContent = i.toString();
    if (hasEvent) {
      const dot = document.createElement("span");
      dot.className = "event-dot";
      dateEl.appendChild(dot);
    }

    // Add click event to filter recordatorios
    dateEl.style.cursor = "pointer";
    dateEl.onclick = () => {
      // 1. Activate main nav 'Materias'
      const navBtns = document.querySelectorAll(".nav-btn");
      navBtns.forEach((b) => b.classList.remove("active"));
      const btnMaterias = document.querySelector(
        ".nav-btn[data-target='view-materias']",
      );
      if (btnMaterias) btnMaterias.classList.add("active");

      const titleEl = document.getElementById("view-title");
      const topbarTabs = document.getElementById("topbar-tabs");
      if (titleEl) titleEl.style.display = "none";
      if (topbarTabs) topbarTabs.style.display = "flex";

      // 2. Activate specific tab 'Recordatorios'
      const topTabs = document.querySelectorAll(".topbar-tab");
      topTabs.forEach((t) => t.classList.remove("active"));
      const recordatoriosTab = document.querySelector(
        ".topbar-tab[data-tab-target='view-recordatorios']",
      );
      if (recordatoriosTab) recordatoriosTab.classList.add("active");

      // 3. Activate the view
      const views = document.querySelectorAll(".view");
      views.forEach((v) => v.classList.remove("active"));
      document.getElementById("view-recordatorios")?.classList.add("active");

      // 4. Load the events for the specific day
      cargarRecordatorios(dateStr);
    };

    datesGrid.appendChild(dateEl);
  }

  // Next month dates
  const totalCells = firstDay + daysInMonth;
  const nextMonthDaysCount = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);

  for (let i = 1; i <= nextMonthDaysCount; i++) {
    const dateEl = document.createElement("div");
    dateEl.className = "calendar-date other-month";
    dateEl.textContent = i.toString();
    datesGrid.appendChild(dateEl);
  }
}

async function cargarUltimosModificados() {
  const container = document.getElementById("recent-notes-list");
  if (!container) return;

  try {
    const apuntes = await invoke<Apunte[]>("mostrar_ult_modif");

    if (apuntes.length === 0) {
      container.innerHTML = `<li style="font-size: 0.8rem; color: var(--text-secondary); text-align: center; padding: 0.5rem 0;">No hay apuntes recientes</li>`;
      return;
    }

    container.innerHTML = "";
    apuntes.forEach((apunte) => {
      const li = document.createElement("li");
      li.className = "recent-note-item";

      const [datePart, timePart] = apunte.ult_modificacion.split(" ");
      let formattedDate = apunte.ult_modificacion;

      if (datePart && timePart) {
        const dateParts = datePart.split("-");
        if (dateParts.length === 3) {
          formattedDate = `${dateParts[2]}/${dateParts[1]}/${dateParts[0]} ${timePart}`;
        }
      } else {
        // Fallback for older entries without time
        const dateParts = apunte.ult_modificacion.split("-");
        if (dateParts.length === 3) {
          formattedDate = `${dateParts[2]}/${dateParts[1]}/${dateParts[0]}`;
        }
      }

      li.innerHTML = `
        <span class="recent-note-tema" title="${apunte.tema}">${apunte.tema}</span>
        <span class="recent-note-fecha">${formattedDate}</span>
      `;
      li.onclick = async () => {
        await abrirEditor(apunte);
      };
      container.appendChild(li);
    });
  } catch (err) {
    console.error("Error cargando apuntes recientes", err);
    container.innerHTML = `<li style="font-size: 0.8rem; color: var(--error);">Error al cargar.</li>`;
  }
}
async function abrirEditor(apunte: Apunte) {
  console.log(`Intentando abrir apunte en ruta: ${apunte.ruta}`);
  try {
    // 1. Cerrar cualquier modal abierto inmediatamente
    const modalVer = document.getElementById("modal-ver-apuntes");
    if (modalVer) modalVer.classList.remove("active");
    const modalApu = document.getElementById("modal-apunte");
    if (modalApu) modalApu.classList.remove("active");

    // 2. Activar la vista del editor de inmediato para feedback instantáneo
    const views = document.querySelectorAll(".view");
    views.forEach((v) => v.classList.remove("active"));
    document.getElementById("view-editor-apunte")?.classList.add("active");

    const appContainer = document.querySelector(".app-container");
    if (appContainer) {
      appContainer.classList.add("editor-mode");
    }

    const titleEl = document.getElementById("view-title");
    if (titleEl) titleEl.textContent = `Editando: ${apunte.tema}`;

    const editorTitle = document.getElementById("editor-title");
    if (editorTitle) editorTitle.textContent = apunte.tema;

    const navBtns = document.querySelectorAll(".nav-btn");
    navBtns.forEach((b) => b.classList.remove("active"));

    currentEditPath = apunte.ruta;
    currentEditCodigo = apunte.codigo_apunte;
    currentEditSincronizarDrive = !!apunte.sincronizar_drive;
    actualizarToggleDriveUI(currentEditSincronizarDrive);

    // Asegurar que TipTap esté disponible
    const editor = initTipTapEditor();

    // 3. Leer el contenido del archivo desde el backend
    const content = await invoke<string>("abrir_apunte", { path: apunte.ruta });
    console.log(
      `Contenido leído correctamente (${content.length} caracteres).`,
    );

    // 4. Desacoplar el parseo y renderizado pesado al siguiente frame para mantener la animación fluida
    requestAnimationFrame(async () => {
      if (editor) {
        console.log("Seteando valor en el editor...");
        const htmlContent = await marked.parse(content);

        const lastSlash = Math.max(
          apunte.ruta.lastIndexOf("/"),
          apunte.ruta.lastIndexOf("\\"),
        );
        const parentDir =
          lastSlash !== -1 ? apunte.ruta.substring(0, lastSlash) : "";

        const parser = new DOMParser();
        const doc = parser.parseFromString(htmlContent, "text/html");
        const imgs = doc.querySelectorAll("img");
        imgs.forEach((img) => {
          const src = img.getAttribute("src");
          if (src) {
            const rel = recortarRutaRecursos(src);
            if (rel.startsWith(".recursos/")) {
              const absolutePath = parentDir ? `${parentDir}/${rel}` : rel;
              const assetUrl = convertFileSrc(absolutePath);
              img.setAttribute("src", assetUrl);
            }
          }
        });
        const finalHtmlContent = doc.body.innerHTML;

        editor.commands.setContent(finalHtmlContent);
      } else {
        console.error("editorInstancia es null, no se pudo establecer el valor.");
      }
    });

    cargarRecordatoriosHoy();
  } catch (error: any) {
    console.error("Error al abrir apunte:", error);
    showToast(`Error al abrir apunte: ${error}`, "error");
  }
}

// ─── Google Drive Cloud Sync & Import ──────────────────────────────────────────
let currentEditSincronizarDrive: boolean = false;
let isGoogleDriveConnected: boolean = false;
let selectedDriveFileId: string | null = null;
let selectedDriveFileName: string | null = null;

type CloudStatus = "offline" | "syncing" | "synced" | "unlinked";

function actualizarToggleDriveUI(activo: boolean) {
  const btn = document.getElementById("btn-editor-toggle-drive");
  const text = document.getElementById("text-editor-drive-sync");
  if (btn) {
    if (activo) {
      btn.classList.add("drive-active");
      if (text) text.textContent = "Drive: Activo";
      btn.title = "Sincronización con Drive activada para este apunte (clic para desactivar)";
    } else {
      btn.classList.remove("drive-active");
      if (text) text.textContent = "Drive: Off";
      btn.title = "Sincronización con Drive desactivada (clic para activar)";
    }
  }
}

function actualizarIconoNubecita(estado: CloudStatus) {
  const btn = document.getElementById("btn-cloud-sync-status");
  const icon = document.getElementById("icon-cloud-status");
  if (!btn || !icon) return;

  btn.classList.remove(
    "cloud-status-offline",
    "cloud-status-syncing",
    "cloud-status-synced",
    "cloud-status-unlinked",
  );

  switch (estado) {
    case "offline":
      btn.classList.add("cloud-status-offline");
      btn.title = "Sin conexión a Internet";
      // Nube cortada (CloudOff)
      icon.innerHTML = `<path d="m2 2 20 20"/><path d="M5.782 5.782A7 7 0 0 0 9 19h8.5a4.5 4.5 0 0 0 1.307-.193"/><path d="M21.532 16.5A4.5 4.5 0 0 0 17.5 10h-1.79A7.008 7.008 0 0 0 10 5.07"/>`;
      break;
    case "syncing":
      btn.classList.add("cloud-status-syncing");
      btn.title = "Sincronizando con Google Drive…";
      // Nube con flechas / pulso
      icon.innerHTML = `<path d="M12 13v8l-4-4"/><path d="m12 21 4-4"/><path d="M4.393 15.269A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 3.5 7.369"/>`;
      break;
    case "synced":
      btn.classList.add("cloud-status-synced");
      btn.title = "Google Drive sincronizado";
      // Nube con tilde (CloudCheck)
      icon.innerHTML = `<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/><path d="m9 14 2 2 4-4"/>`;
      break;
    case "unlinked":
    default:
      btn.classList.add("cloud-status-unlinked");
      btn.title = "Google Drive no conectado (clic para vincular)";
      // Nube normal
      icon.innerHTML = `<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>`;
      break;
  }
}

async function verificarEstadoGoogleDrive() {
  if (!navigator.onLine) {
    actualizarIconoNubecita("offline");
    return;
  }
  try {
    const estado = await invoke<{ conectado: boolean; email?: string | null }>(
      "obtener_estado_google",
    );
    isGoogleDriveConnected = estado.conectado;
    const statusText = document.getElementById("settings-drive-status");
    const emailText = document.getElementById("settings-drive-email");
    const btnConectar = document.getElementById("btn-conectar-drive");
    const btnDesconectar = document.getElementById("btn-desconectar-drive");

    if (estado.conectado) {
      actualizarIconoNubecita("synced");
      if (statusText) statusText.textContent = "Conectado";
      if (emailText) {
        emailText.textContent = estado.email ? `Cuenta: ${estado.email}` : "";
        emailText.style.display = estado.email ? "block" : "none";
      }
      if (btnConectar) btnConectar.style.display = "none";
      if (btnDesconectar) btnDesconectar.style.display = "block";
    } else {
      actualizarIconoNubecita("unlinked");
      if (statusText) statusText.textContent = "No conectado";
      if (emailText) emailText.style.display = "none";
      if (btnConectar) btnConectar.style.display = "block";
      if (btnDesconectar) btnDesconectar.style.display = "none";
    }
  } catch (err) {
    console.error("Error al obtener estado de Google Drive:", err);
    actualizarIconoNubecita("unlinked");
  }
}

async function sincronizarApuntesAlInicio() {
  if (!navigator.onLine) {
    actualizarIconoNubecita("offline");
    return;
  }
  await verificarEstadoGoogleDrive();
  if (!isGoogleDriveConnected) {
    return;
  }

  actualizarIconoNubecita("syncing");
  try {
    const actualizados = await invoke<string[]>("sincronizar_apuntes_registrados");
    actualizarIconoNubecita("synced");
    if (actualizados && actualizados.length > 0) {
      showToast(
        `Se sincronizaron ${actualizados.length} apunte(s) desde Drive: ${actualizados.join(", ")}`,
        "success",
      );
      cargarUltimosModificados();
      cargarMaterias();

      // Si el apunte que el usuario tiene abierto se acaba de actualizar, recargar su contenido en TipTap
      if (currentEditPath && editorInstancia) {
        const apunteAbierto = actualizados.some((t) => currentEditPath.includes(t));
        if (apunteAbierto) {
          try {
            const content = await invoke<string>("abrir_apunte", { path: currentEditPath });
            const htmlContent = await marked.parse(content);
            const parentDir = getParentDirFromPath(currentEditPath);
            const parser = new DOMParser();
            const doc = parser.parseFromString(htmlContent, "text/html");
            const imgs = doc.querySelectorAll("img");
            imgs.forEach((img) => {
              const src = img.getAttribute("src");
              if (src) {
                const rel = recortarRutaRecursos(src);
                if (rel.startsWith(".recursos/")) {
                  const absolutePath = parentDir ? `${parentDir}/${rel}` : rel;
                  img.setAttribute("src", convertFileSrc(absolutePath));
                }
              }
            });
            editorInstancia.commands.setContent(doc.body.innerHTML);
            showToast("El apunte en edición se actualizó con los cambios de Google Drive", "success");
          } catch (e) {
            console.error("Error al recargar apunte abierto tras sincronización:", e);
          }
        }
      }
    }
  } catch (err: any) {
    console.error("Error durante sincronización al inicio:", err);
    actualizarIconoNubecita(isGoogleDriveConnected ? "synced" : "unlinked");
  }
}

function setupCloudSync() {
  window.addEventListener("online", () => {
    verificarEstadoGoogleDrive().then(() => {
      sincronizarApuntesAlInicio();
    });
  });

  window.addEventListener("offline", () => {
    actualizarIconoNubecita("offline");
  });

  const btnCloudStatus = document.getElementById("btn-cloud-sync-status");
  btnCloudStatus?.addEventListener("click", () => {
    if (!navigator.onLine) {
      showToast("Sin conexión a Internet", "error");
      return;
    }
    if (!isGoogleDriveConnected) {
      abrirModal("modal-settings");
    } else {
      showToast("Verificando sincronización con Google Drive…", "success");
      sincronizarApuntesAlInicio();
    }
  });

  // Settings: Google Drive actions
  const btnConectar = document.getElementById("btn-conectar-drive");
  const btnDesconectar = document.getElementById("btn-desconectar-drive");
  const btnGuardarConfig = document.getElementById("btn-guardar-drive-config");

  btnConectar?.addEventListener("click", async () => {
    const inputClientId = (document.getElementById("settings-drive-client-id") as HTMLInputElement)?.value;
    const inputClientSecret = (document.getElementById("settings-drive-client-secret") as HTMLInputElement)?.value;

    try {
      showToast("Abriendo navegador para iniciar sesión con Google…", "success");
      const resp = await invoke<{ conectado: boolean; email?: string | null }>(
        "iniciar_sesion_google",
        {
          clientId: inputClientId || null,
          clientSecret: inputClientSecret || null,
        },
      );
      if (resp.conectado) {
        showToast(`¡Conectado exitosamente con ${resp.email || "Google Drive"}!`, "success");
        await verificarEstadoGoogleDrive();
        await sincronizarApuntesAlInicio();
      }
    } catch (err: any) {
      console.error("Error al conectar con Google Drive:", err);
      showToast(`Error al conectar con Google Drive: ${err}`, "error");
    }
  });

  btnDesconectar?.addEventListener("click", async () => {
    try {
      await invoke("desconectar_google");
      showToast("Google Drive desconectado", "success");
      await verificarEstadoGoogleDrive();
    } catch (err: any) {
      showToast(`Error al desconectar: ${err}`, "error");
    }
  });

  btnGuardarConfig?.addEventListener("click", async () => {
    const clientId = (document.getElementById("settings-drive-client-id") as HTMLInputElement)?.value;
    const clientSecret = (document.getElementById("settings-drive-client-secret") as HTMLInputElement)?.value;
    try {
      await invoke("guardar_config_google", { clientId: clientId || "", clientSecret: clientSecret || "" });
      showToast("Configuración de credenciales guardada", "success");
    } catch (e: any) {
      showToast(`Error guardando configuración: ${e}`, "error");
    }
  });

  // Load existing config into inputs
  invoke<{ client_id: string; client_secret: string }>("obtener_config_google")
    .then((cfg) => {
      if (cfg) {
        const inpId = document.getElementById("settings-drive-client-id") as HTMLInputElement;
        const inpSec = document.getElementById("settings-drive-client-secret") as HTMLInputElement;
        if (inpId && cfg.client_id) inpId.value = cfg.client_id;
        if (inpSec && cfg.client_secret) inpSec.value = cfg.client_secret;
      }
    })
    .catch(() => {});
}

function setupDriveImport() {
  const modalDrive = document.getElementById("modal-importar-drive");
  const btnClose = document.getElementById("close-modal-importar-drive");
  const btnCancel = document.getElementById("btn-cancelar-import-drive");
  const btnSelectRuta = document.getElementById("btn-drive-select-ruta");
  const btnEjecutar = document.getElementById("btn-ejecutar-import-drive") as HTMLButtonElement | null;
  const inputRuta = document.getElementById("drive-import-ruta") as HTMLInputElement | null;
  const selectMateria = document.getElementById("drive-import-materia") as HTMLSelectElement | null;

  const cerrarModalDrive = () => {
    modalDrive?.classList.remove("active");
    selectedDriveFileId = null;
    selectedDriveFileName = null;
    if (btnEjecutar) btnEjecutar.disabled = true;
  };

  btnClose?.addEventListener("click", cerrarModalDrive);
  btnCancel?.addEventListener("click", cerrarModalDrive);
  modalDrive?.addEventListener("click", (e) => {
    if (e.target === modalDrive) cerrarModalDrive();
  });

  btnSelectRuta?.addEventListener("click", async () => {
    const r = await seleccionarRuta(true);
    if (r && inputRuta) {
      inputRuta.value = r;
      try {
        localStorage.setItem("estudio_last_import_folder", r);
      } catch (e) {}
      validarFormularioImportDrive();
    }
  });

  function validarFormularioImportDrive() {
    if (btnEjecutar) {
      const tieneArchivo = !!selectedDriveFileId;
      const tieneRuta = !!inputRuta?.value.trim();
      const tieneMateria = !!selectMateria?.value;
      btnEjecutar.disabled = !(tieneArchivo && tieneRuta && tieneMateria);
    }
  }

  inputRuta?.addEventListener("input", validarFormularioImportDrive);
  selectMateria?.addEventListener("change", validarFormularioImportDrive);

  // Global button in view-materias
  const btnImportGlobal = document.getElementById("btn-import-drive");
  btnImportGlobal?.addEventListener("click", () => {
    abrirModalImportarDrive(null);
  });

  // Modal button in modal-ver-apuntes
  const btnImportModal = document.getElementById("btn-modal-importar-drive");
  btnImportModal?.addEventListener("click", () => {
    abrirModalImportarDrive(currentMateriaForModal);
  });

  btnEjecutar?.addEventListener("click", async () => {
    if (!selectedDriveFileId || !inputRuta?.value || !selectMateria?.value) {
      showToast("Completa todos los campos para importar", "error");
      return;
    }

    setButtonLoading(btnEjecutar, true, "Descargando…");
    actualizarIconoNubecita("syncing");
    try {
      const apunte = await invoke<Apunte>("descargar_apunte_drive", {
        fileId: selectedDriveFileId,
        materiaCodigo: selectMateria.value,
        rutaDestino: inputRuta.value.trim(),
      });

      const nombreFinal = selectedDriveFileName?.replace(/_export\.zip$/i, "").replace(/\.zip$/i, "") || apunte.tema;
      showToast(`Apunte "${nombreFinal}" importado y sincronizado correctamente`, "success");
      actualizarIconoNubecita("synced");
      cerrarModalDrive();
      cargarUltimosModificados();
      if (currentMateriaForModal) {
        await abrirModalVerApuntes(currentMateriaForModal);
      }
    } catch (err: any) {
      console.error("Error descargando apunte de Drive:", err);
      showToast(`Error al importar de Drive: ${err}`, "error");
      actualizarIconoNubecita(isGoogleDriveConnected ? "synced" : "unlinked");
    } finally {
      setButtonLoading(btnEjecutar, false);
    }
  });
}

async function abrirModalImportarDrive(materiaPreseleccionada: Materia | null) {
  if (!navigator.onLine) {
    showToast("Se requiere conexión a Internet para importar desde Google Drive", "error");
    return;
  }
  if (!isGoogleDriveConnected) {
    showToast("Debes vincular tu cuenta de Google Drive primero en Configuración", "error");
    abrirModal("modal-settings");
    return;
  }

  abrirModal("modal-importar-drive");
  const loadingEl = document.getElementById("drive-files-loading");
  const emptyEl = document.getElementById("drive-files-empty");
  const listEl = document.getElementById("drive-files-list");
  const selectMateria = document.getElementById("drive-import-materia") as HTMLSelectElement | null;
  const btnEjecutar = document.getElementById("btn-ejecutar-import-drive") as HTMLButtonElement | null;

  const inputRuta = document.getElementById("drive-import-ruta") as HTMLInputElement | null;
  const lastFolder = localStorage.getItem("estudio_last_import_folder");
  if (inputRuta && lastFolder && !inputRuta.value.trim()) {
    inputRuta.value = lastFolder;
  }

  if (loadingEl) loadingEl.style.display = "block";
  if (emptyEl) emptyEl.style.display = "none";
  if (listEl) listEl.innerHTML = "";
  if (btnEjecutar) btnEjecutar.disabled = true;
  selectedDriveFileId = null;
  selectedDriveFileName = null;

  // Población del selector de materias
  if (selectMateria) {
    selectMateria.innerHTML = "";
    if (!materiasCache || materiasCache.length === 0) {
      try {
        materiasCache = await invoke<Materia[]>("mostrar_materias");
      } catch (e) {}
    }
    if (materiasCache && materiasCache.length > 0) {
      materiasCache.forEach((m) => {
        const opt = document.createElement("option");
        opt.value = m.codigo.toString();
        opt.textContent = `${m.nombre} (Año ${m.ano})`;
        if (materiaPreseleccionada && m.codigo === materiaPreseleccionada.codigo) {
          opt.selected = true;
        }
        selectMateria.appendChild(opt);
      });
    } else {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No hay materias creadas";
      selectMateria.appendChild(opt);
    }
  }

  // Carga de archivos desde Drive
  try {
    const files = await invoke<Array<{ id: string; name: string; modified_time: string; size?: number }>>(
      "listar_apuntes_drive",
    );
    if (loadingEl) loadingEl.style.display = "none";

    if (!files || files.length === 0) {
      if (emptyEl) emptyEl.style.display = "block";
      return;
    }

    if (listEl) {
      files.forEach((f) => {
        const item = document.createElement("div");
        item.className = "drive-file-item";
        item.dataset.id = f.id;

        // Limpiar sufijo _export.zip para presentación
        const nombreLimpio = f.name.replace(/_export\.zip$/i, "").replace(/\.zip$/i, "");
        const fechaFormat = f.modified_time
          ? new Date(f.modified_time).toLocaleDateString("es-ES", {
              day: "2-digit",
              month: "2-digit",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })
          : "";

        item.innerHTML = `
          <div class="drive-file-item-info">
            <div class="drive-file-icon">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/>
                <path d="M14 2v4a2 2 0 0 0 2 2h4"/>
              </svg>
            </div>
            <span class="drive-file-name" title="${nombreLimpio}">${nombreLimpio}</span>
          </div>
          <div class="drive-file-meta">
            ${fechaFormat ? `<span class="drive-file-date">${fechaFormat}</span>` : ""}
            <span class="drive-file-check" title="Seleccionado">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            </span>
          </div>
        `;

        item.addEventListener("click", () => {
          document.querySelectorAll(".drive-file-item").forEach((el) => el.classList.remove("selected"));
          item.classList.add("selected");
          selectedDriveFileId = f.id;
          selectedDriveFileName = f.name;

          const inputRuta = document.getElementById("drive-import-ruta") as HTMLInputElement | null;
          const tieneRuta = !!inputRuta?.value.trim();
          const tieneMateria = !!selectMateria?.value;
          if (btnEjecutar) {
            btnEjecutar.disabled = !(tieneRuta && tieneMateria);
          }
        });

        listEl.appendChild(item);
      });
    }
  } catch (err: any) {
    if (loadingEl) loadingEl.style.display = "none";
    showToast(`Error al consultar Google Drive: ${err}`, "error");
  }
}
