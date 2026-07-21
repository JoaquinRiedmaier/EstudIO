import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import { readImage } from "@tauri-apps/plugin-clipboard-manager";
import { seleccionarRuta } from "./file";
import { Editor, Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

import { jsPDF } from "jspdf";
// @ts-ignore
import html2pdf from "html2pdf.js";

import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { Markdown } from "@tiptap/markdown";
import Highlight from "@tiptap/extension-highlight";
import { marked } from "marked";
import TurndownService from "turndown";

const turndownService = new TurndownService({ headingStyle: "atx" });
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
}

interface Evento {
  codigo_evento: number;
  fecha: string;
  hora: string;
  fecha_recordar: string;
  nombre: string;
  descripcion: string;
}

// State
let materiasCache: Materia[] = [];
let eventosCache: Evento[] = [];
let currentCalendarDate = new Date();
let editorInstancia: Editor | null = null;
let currentEditPath: string = "";
let currentEditCodigo: number | null = null;
let materiaToDelete: string | null = null;
let selectedHighlightColor = "#fef08a";

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
  cargarUltimosModificados();
  cargarMaterias();
  cargarRecordatoriosHoy();
});

function setupNavigation() {
  const navBtns = document.querySelectorAll(".nav-btn");
  const views = document.querySelectorAll(".view");
  const titleEl = document.getElementById("view-title");
  const topbarTabs = document.getElementById("topbar-tabs");

  navBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
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
      }
      cargarRecordatoriosHoy();
    });
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

function setupEditor() {
  console.log("Iniciando setupEditor (eventos)...");

  const btnCerrar = document.getElementById("btn-editor-cerrar");
  const btnGuardar = document.getElementById("btn-editor-guardar");
  const btnGuardarCerrar = document.getElementById("btn-editor-guardar-cerrar");
  const btnToggleSidebar = document.getElementById("btn-toggle-sidebar");

  btnCerrar?.addEventListener("click", () => {
    cerrarEditor();
  });

  btnGuardar?.addEventListener("click", async () => {
    await guardarApunteActual();
  });

  btnGuardarCerrar?.addEventListener("click", async () => {
    const exito = await guardarApunteActual();
    if (exito) cerrarEditor();
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
      "background: rgba(44, 42, 41, 0.7)",
      "backdrop-filter: blur(3px)",
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
  if (titleEl) titleEl.textContent = "Materias";

  const navBtns = document.querySelectorAll(".nav-btn");
  navBtns.forEach((b) => {
    b.classList.remove("active");
    if (b.getAttribute("data-target") === "view-materias") {
      b.classList.add("active");
    }
  });

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
        const idx = src.indexOf(".recursos/");
        if (idx !== -1) {
          img.setAttribute("src", src.substring(idx));
        }
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
    const content = await invoke<string>("abrir_apunte", { path: apunte.ruta });
    console.log(
      `Contenido leído correctamente (${content.length} caracteres).`,
    );

    const modal = document.getElementById("modal-ver-apuntes");
    if (modal) modal.classList.remove("active");

    const views = document.querySelectorAll(".view");
    views.forEach((v) => v.classList.remove("active"));
    document.getElementById("view-editor-apunte")?.classList.add("active");

    const appContainer = document.querySelector(".app-container");
    if (appContainer) {
      appContainer.classList.add("editor-mode");
    }

    cargarRecordatoriosHoy();

    const titleEl = document.getElementById("view-title");
    if (titleEl) titleEl.textContent = `Editando: ${apunte.tema}`;

    const editorTitle = document.getElementById("editor-title");
    if (editorTitle) editorTitle.textContent = apunte.tema;

    if (!editorInstancia) {
      try {
        const container = document.getElementById("tiptap-editor");
        if (container) {
          editorInstancia = new Editor({
            element: container,
            extensions: [
              CustomPasteExtension,
              StarterKit,
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
    }

    if (editorInstancia) {
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
        if (src && src.startsWith(".recursos/")) {
          const absolutePath = parentDir ? `${parentDir}/${src}` : src;
          const assetUrl = convertFileSrc(absolutePath);
          img.setAttribute("src", assetUrl);
        }
      });
      const finalHtmlContent = doc.body.innerHTML;

      editorInstancia.commands.setContent(finalHtmlContent);
    } else {
      console.error("editorInstancia es null, no se pudo establecer el valor.");
    }
    currentEditPath = apunte.ruta;
    currentEditCodigo = apunte.codigo_apunte;

    const navBtns = document.querySelectorAll(".nav-btn");
    navBtns.forEach((b) => b.classList.remove("active"));
  } catch (error: any) {
    console.error("Error al abrir apunte:", error);
    showToast(`Error al abrir apunte: ${error}`, "error");
  }
}
