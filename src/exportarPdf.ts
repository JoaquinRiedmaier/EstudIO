import type { CustomTableLayout, TDocumentDefinitions } from "pdfmake/interfaces";
// @ts-ignore: html-to-pdfmake no trae tipos
import htmlToPdfmake from "html-to-pdfmake";

// ── Página ────────────────────────────────────────────────────────────────────
// A4 en pt (1 cm = 28.3465 pt). Márgenes: 2 cm a la izquierda y 1,5 cm en el resto.
const CM = 28.3465;
const ANCHO_A4 = 595.28;
const ALTO_A4 = 841.89;
const MARGENES: [number, number, number, number] = [2 * CM, 1.5 * CM, 1.5 * CM, 1.5 * CM]; // izq, arriba, der, abajo
const ANCHO_UTIL = ANCHO_A4 - MARGENES[0] - MARGENES[2];
const ALTO_UTIL = ALTO_A4 - MARGENES[1] - MARGENES[3];
const ALTO_MAX_IMAGEN = ALTO_UTIL - 30;
const ANCHO_EDITOR_POR_DEFECTO = 700;

// ── Estilo ────────────────────────────────────────────────────────────────────
const COLOR_TEXTO = "#2c2a29";
const COLOR_ACENTO = "#2c4c3b";
const COLOR_BORDE = "#dcd7c8";
const PADDING_CELDA_H = 6;

const FUENTE_MONO = "DejaVuSansMono";
const FUENTE_SIMBOLOS = "DejaVuSans";
// Roboto (la fuente que trae pdfmake) no tiene flechas, conjuntos, checks, etc.
// Esos caracteres se escriben con DejaVu Sans.
const SIMBOLOS = /[℀-⅏←-⏿①-⓿■-⫿]+/g;

function lineaInferior(grosor: number, color: string, separacion: number): CustomTableLayout {
  return {
    hLineWidth: (i, nodo) => (i === nodo.table.body.length ? grosor : 0),
    vLineWidth: () => 0,
    hLineColor: () => color,
    paddingLeft: () => 0,
    paddingRight: () => 0,
    paddingTop: () => 0,
    paddingBottom: () => separacion,
  };
}

const LAYOUTS: Record<string, CustomTableLayout> = {
  apunteTabla: {
    hLineWidth: () => 0.6,
    vLineWidth: () => 0.6,
    hLineColor: () => COLOR_BORDE,
    vLineColor: () => COLOR_BORDE,
    paddingLeft: () => PADDING_CELDA_H,
    paddingRight: () => PADDING_CELDA_H,
    paddingTop: () => 4,
    paddingBottom: () => 4,
  },
  apunteCodigo: {
    hLineWidth: () => 0.6,
    vLineWidth: () => 0.6,
    hLineColor: () => COLOR_BORDE,
    vLineColor: () => COLOR_BORDE,
    fillColor: () => "#f5f2ec",
    paddingLeft: () => 8,
    paddingRight: () => 8,
    paddingTop: () => 6,
    paddingBottom: () => 6,
  },
  // Títulos: como en el editor, H1 con línea gris a todo el ancho y H3 subrayado del ancho del texto
  apunteTituloLinea: lineaInferior(0.8, COLOR_BORDE, 4),
  apunteTituloSubrayado: lineaInferior(1.5, COLOR_ACENTO, 2),
  apunteCita: {
    hLineWidth: () => 0,
    vLineWidth: (i) => (i === 0 ? 3 : 0),
    vLineColor: () => COLOR_ACENTO,
    fillColor: () => "#f9f8f4",
    paddingLeft: () => 10,
    paddingRight: () => 8,
    paddingTop: () => 5,
    paddingBottom: () => 5,
  },
};

const TITULO_MENOR = { fontSize: 11.5, bold: true, margin: [0, 8, 0, 3], marginBottom: "" };

const OPCIONES_HTML = {
  ignoreStyles: ["font-family"],
  // marginBottom/marginLeft: "" borra los valores por defecto de html-to-pdfmake
  defaultStyles: {
    h1: { fontSize: 20, bold: true, color: COLOR_ACENTO, lineHeight: 1.1, margin: [0, 14, 0, 8], marginBottom: "" },
    h2: { fontSize: 15, bold: true, color: COLOR_ACENTO, lineHeight: 1.1, margin: [0, 12, 0, 5], marginBottom: "" },
    h3: { fontSize: 12.5, bold: true, margin: [0, 10, 0, 4], marginBottom: "" },
    h4: TITULO_MENOR,
    h5: TITULO_MENOR,
    h6: TITULO_MENOR,
    p: { margin: [0, 0, 0, 6] },
    ul: { margin: [4, 0, 0, 6], marginBottom: "", marginLeft: "" },
    ol: { margin: [4, 0, 0, 6] },
    a: { color: COLOR_ACENTO },
    table: { margin: [0, 4, 0, 10], marginBottom: "" },
    th: { bold: true, fontSize: 10, color: "#f8fafc", fillColor: COLOR_ACENTO },
    td: { fontSize: 10 },
    code: { font: FUENTE_MONO, fontSize: 9.5, color: "#c0392b", background: "#f0ede6" },
    pre: { font: FUENTE_MONO, fontSize: 9, lineHeight: 1.15 },
    blockquote: { color: "#555555" },
  },
};

/**
 * Genera el PDF de un apunte a partir del HTML de Tiptap y lo devuelve en Base64.
 * `editorEl` se usa para escalar imágenes y columnas en la misma proporción que en el editor.
 */
export async function generarPdfApunte(html: string, titulo: string, editorEl: HTMLElement | null): Promise<string> {
  const anchoEditorPx = anchoContenido(editorEl) || ANCHO_EDITOR_POR_DEFECTO;
  const [pdfMake, htmlPreparado] = await Promise.all([cargarPdfMake(), prepararHtml(html, anchoEditorPx)]);

  const contenido = ajustarNodo(htmlToPdfmake(htmlPreparado, OPCIONES_HTML));
  if (Array.isArray(contenido)) {
    // El primer bloque arranca pegado al margen superior
    if (Array.isArray(contenido[0]?.margin)) contenido[0].margin[1] = 0;
    // Un párrafo corto antes de una imagen (tipo "Figura 1:") viaja con ella, igual que un título
    contenido.forEach((nodo, i) => {
      const siguiente = contenido[i + 1];
      if (nodo?.nodeName === "P" && siguiente?.nodeName === "IMG" && textoPlano(nodo).length <= 200) {
        nodo.headlineLevel = 7;
      }
    });
  }

  const documento: TDocumentDefinitions = {
    pageSize: "A4",
    pageMargins: MARGENES,
    info: { title: titulo },
    content: contenido,
    defaultStyle: { font: "Roboto", fontSize: 11, lineHeight: 1.25, color: COLOR_TEXTO },
    // Un título nunca queda solo al pie de la página: si no le sigue nada, pasa a la siguiente
    pageBreakBefore: (nodo, consultas) =>
      !!nodo.headlineLevel &&
      !consultas.getFollowingNodesOnPage().some((n) => tieneContenido(n) && n.style !== TEXTO_DE_TITULO) &&
      consultas.getNodesOnNextPage().length > 0 &&
      consultas.getPreviousNodesOnPage().length > 0,
  };

  return pdfMake.createPdf(documento).getBase64();
}

function tieneContenido(nodo: { text?: unknown }): boolean {
  return !(typeof nodo.text === "string" && !nodo.text.trim());
}

// ── Carga diferida de pdfmake y fuentes (solo al exportar) ────────────────────
let pdfMakeListo: Promise<any> | null = null;

function cargarPdfMake(): Promise<any> {
  if (!pdfMakeListo) {
    pdfMakeListo = (async () => {
      const [modPdfMake, modVfs, dejaVuSans, dejaVuMono] = await Promise.all([
        import("pdfmake/build/pdfmake"),
        import("pdfmake/build/vfs_fonts"),
        urlABase64(new URL("./assets/fonts/DejaVuSans.ttf", import.meta.url).href),
        urlABase64(new URL("./assets/fonts/DejaVuSansMono.ttf", import.meta.url).href),
      ]);
      const pdfMake = (modPdfMake as any).default ?? modPdfMake;
      pdfMake.addVirtualFileSystem((modVfs as any).default ?? modVfs);
      pdfMake.addVirtualFileSystem({ "DejaVuSans.ttf": dejaVuSans, "DejaVuSansMono.ttf": dejaVuMono });
      // Una sola variante por fuente: negrita/cursiva caen en la regular en vez de fallar
      pdfMake.addFonts({
        [FUENTE_SIMBOLOS]: variantes("DejaVuSans.ttf"),
        [FUENTE_MONO]: variantes("DejaVuSansMono.ttf"),
      });
      pdfMake.addTableLayouts(LAYOUTS);
      return pdfMake;
    })().catch((e) => {
      pdfMakeListo = null;
      throw e;
    });
  }
  return pdfMakeListo;
}

function variantes(archivo: string) {
  return { normal: archivo, bold: archivo, italics: archivo, bolditalics: archivo };
}

async function urlABase64(url: string): Promise<string> {
  const respuesta = await fetch(url);
  if (!respuesta.ok) throw new Error(`No se pudo cargar ${url}`);
  const dataUrl = await blobADataUrl(await respuesta.blob());
  return dataUrl.split(",")[1] ?? "";
}

function blobADataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function anchoContenido(el: HTMLElement | null): number {
  if (!el) return 0;
  const estilo = getComputedStyle(el);
  return el.clientWidth - parseFloat(estilo.paddingLeft) - parseFloat(estilo.paddingRight);
}

// ── HTML → HTML listo para html-to-pdfmake ────────────────────────────────────
const BLOQUES = new Set(["BODY", "BLOCKQUOTE", "UL", "OL", "LI", "TABLE", "COLGROUP", "TBODY", "THEAD", "TR", "TD", "TH"]);

async function prepararHtml(html: string, anchoEditorPx: number): Promise<string> {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const escala = ANCHO_UTIL / anchoEditorPx;

  // Espacios entre bloques: html-to-pdfmake los convierte en renglones " " sueltos
  const recorrido = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const vacios: Node[] = [];
  while (recorrido.nextNode()) {
    const nodo = recorrido.currentNode;
    if (!nodo.textContent?.trim() && BLOQUES.has(nodo.parentElement?.tagName ?? "")) vacios.push(nodo);
  }
  vacios.forEach((nodo) => nodo.parentNode?.removeChild(nodo));

  // Tiptap guarda el resaltado como "background-color: X; color: inherit" y pdfmake no entiende "inherit"
  doc.querySelectorAll<HTMLElement>("mark").forEach((mark) => {
    const color = mark.dataset.color || mark.style.backgroundColor || "#fef08a";
    mark.setAttribute("style", `background-color: ${color}`);
  });

  // En el editor un párrafo vacío ocupa un renglón; en pdfmake desaparecería
  doc.querySelectorAll("p").forEach((p) => {
    if (!p.textContent && !p.querySelector("img, br")) p.innerHTML = "&nbsp;";
  });

  // Bloques de código: solo el texto, para que no hereden el estilo del código en línea
  doc.querySelectorAll("pre").forEach((pre) => {
    pre.textContent = (pre.textContent ?? "").replace(/\n$/, "");
  });

  doc.querySelectorAll("hr").forEach((hr) => {
    hr.setAttribute(
      "data-pdfmake",
      JSON.stringify({ width: ANCHO_UTIL, color: COLOR_BORDE, thickness: 0.8, margin: [0, 8, 0, 8] })
    );
  });

  doc.querySelectorAll("table").forEach((tabla) => {
    const primera = tabla.rows[0];
    if (!primera) return;
    const celdas = Array.from(primera.cells);
    const columnas = celdas.reduce((n, c) => n + (c.colSpan || 1), 0);
    const opciones: Record<string, unknown> = {
      layout: "apunteTabla",
      widths: anchosColumnas(tabla, columnas, escala),
      dontBreakRows: true,
    };
    // Fila de encabezado: se repite en cada página y nunca queda sola al pie
    if (celdas.every((c) => c.tagName === "TH")) {
      opciones.headerRows = 1;
      opciones.keepWithHeaderRows = 1;
    }
    tabla.setAttribute("data-pdfmake", JSON.stringify(opciones));
  });

  await Promise.all(
    Array.from(doc.querySelectorAll("img")).map(async (img) => {
      const imagen = await cargarImagen(img.getAttribute("src") ?? "");
      if (!imagen) {
        img.remove();
        return;
      }
      const anchoEnEditor = Math.min(parseFloat(img.getAttribute("width") ?? "") || imagen.ancho, anchoEditorPx);
      let ancho = Math.min(anchoEnEditor * escala, anchoDisponible(img));
      let alto = ancho * (imagen.alto / imagen.ancho);
      if (alto > ALTO_MAX_IMAGEN) {
        ancho *= ALTO_MAX_IMAGEN / alto;
        alto = ALTO_MAX_IMAGEN;
      }
      img.setAttribute("src", imagen.dataUrl);
      ["width", "height", "style"].forEach((atributo) => img.removeAttribute(atributo));
      img.setAttribute(
        "data-pdfmake",
        JSON.stringify({ width: ancho, height: alto, alignment: "center", margin: [0, 6, 0, 6] })
      );
    })
  );

  return doc.body.innerHTML;
}

/**
 * Columnas redimensionadas en el editor: se escalan al ancho útil y el resto reparte lo que sobra.
 * Sin redimensionar: todas iguales.
 */
function anchosColumnas(tabla: HTMLTableElement, columnas: number, escala: number): (number | string)[] {
  const px = Array.from(tabla.querySelectorAll<HTMLElement>("colgroup > col")).map((col) =>
    parseFloat(col.style.width)
  );
  if (px.length !== columnas || !px.some((n) => n > 0)) return Array(columnas).fill("*");

  const fijas = px.map((n) => (n > 0 ? n * escala : null));
  const libres = fijas.filter((n) => n === null).length;
  const totalFijo = fijas.reduce<number>((suma, n) => suma + (n ?? 0), 0);
  // Se descuenta el padding de cada celda y se reservan 40 pt por columna libre
  const disponible = ANCHO_UTIL - columnas * (2 * PADDING_CELDA_H + 1) - libres * 40;
  const factor = totalFijo > disponible ? disponible / totalFijo : 1;
  return fijas.map((n) => (n === null ? "*" : Math.floor(n * factor)));
}

function anchoDisponible(el: Element): number {
  const celda = el.closest("td, th");
  if (celda) {
    const fila = celda.parentElement as HTMLTableRowElement;
    const columnas = Array.from(fila.cells).reduce((n, c) => n + (c.colSpan || 1), 0);
    return ANCHO_UTIL / columnas - 2 * PADDING_CELDA_H;
  }
  let ancho = ANCHO_UTIL;
  for (let padre = el.parentElement; padre; padre = padre.parentElement) {
    if (padre.tagName === "LI") ancho -= 15;
    if (padre.tagName === "BLOCKQUOTE") ancho -= 20;
  }
  return ancho;
}

interface ImagenPdf {
  dataUrl: string;
  ancho: number;
  alto: number;
}

async function cargarImagen(src: string): Promise<ImagenPdf | null> {
  try {
    let dataUrl = await imgToDataUrl(src);
    if (!dataUrl.startsWith("data:")) throw new Error("no se pudo leer la imagen");
    const img = document.createElement("img");
    img.src = dataUrl;
    await img.decode();
    const ancho = img.naturalWidth || 300;
    const alto = img.naturalHeight || 150;
    // pdfmake solo acepta PNG y JPEG: el resto (webp, gif, svg…) se rasteriza
    if (!/^data:image\/(png|jpe?g)[;,]/i.test(dataUrl)) {
      const canvas = document.createElement("canvas");
      canvas.width = ancho;
      canvas.height = alto;
      canvas.getContext("2d")?.drawImage(img, 0, 0, ancho, alto);
      dataUrl = canvas.toDataURL("image/png");
    }
    return { dataUrl, ancho, alto };
  } catch (e) {
    console.warn("Imagen omitida en el PDF:", src, e);
    return null;
  }
}

/**
 * Convierte cualquier URL de imagen a Data URL Base64 de forma infalible.
 */
async function imgToDataUrl(src: string): Promise<string> {
  if (!src) return src;
  if (src.startsWith("data:")) return src;

  try {
    const response = await fetch(src);
    return await blobADataUrl(await response.blob());
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

// ── Ajustes sobre el árbol de pdfmake ─────────────────────────────────────────
const LISTAS = new Set(["LI", "UL", "OL"]);
const CONTENEDORES_COMPACTOS = new Set([...LISTAS, "TD", "TH", "BLOCKQUOTE"]);

function ajustarNodo(nodo: any, padre?: string, fuente?: string): any {
  if (Array.isArray(nodo)) return nodo.map((n) => ajustarNodo(n, padre, fuente));
  if (!nodo || typeof nodo !== "object") return nodo;

  const nombre: string | undefined = nodo.nodeName;
  const contexto = nombre ?? padre;
  const fuenteActual = nodo.font ?? fuente;

  for (const clave of ["stack", "ul", "ol"]) {
    if (Array.isArray(nodo[clave])) nodo[clave] = nodo[clave].map((n: any) => ajustarNodo(n, contexto, fuenteActual));
  }
  if (nodo.table?.body) {
    nodo.table.body = nodo.table.body.map((fila: any[]) => fila.map((celda) => ajustarNodo(celda, "TD", fuenteActual)));
  }
  if (typeof nodo.text === "string") {
    nodo.text = conSimbolos(nodo.text, nodo, fuenteActual);
  } else if (Array.isArray(nodo.text)) {
    nodo.text = nodo.text.flatMap((n: any) =>
      typeof n === "string" ? conSimbolos(n, nodo, fuenteActual) : [ajustarNodo(n, contexto, fuenteActual)]
    );
  }

  if (nombre === "P" && padre && CONTENEDORES_COMPACTOS.has(padre)) nodo.margin = [0, 0, 0, 3];
  if ((nombre === "UL" || nombre === "OL") && padre && LISTAS.has(padre)) nodo.margin = [0, 0, 0, 0];
  if (nombre && /^H[1-6]$/.test(nombre)) nodo.headlineLevel = Number(nombre[1]);
  if (nombre === "H1") return tituloConLinea(nodo, "apunteTituloLinea", "*");
  if (nombre === "H3") return tituloConLinea(nodo, "apunteTituloSubrayado", "auto");
  // Bloques cortos no se parten; los largos sí (pdfmake recorta lo que no entra en una página)
  if (nombre === "PRE") return envolverEnCaja(nodo, "apunteCodigo", textoPlano(nodo).split("\n").length <= 45);
  if (nombre === "BLOCKQUOTE") return envolverEnCaja(nodo, "apunteCita", textoPlano(nodo).length <= 1500);
  return nodo;
}

// pdfmake aplana los textos anidados y pierde las propiedades del padre,
// así que cada fragmento las lleva copiadas
const PROPIEDADES_EN_LINEA = [
  "bold", "italics", "color", "background", "decoration", "fontSize", "font", "link", "linkToDestination", "sup", "sub", "opacity",
];

function conSimbolos(texto: string, nodo: any, fuente?: string): string | any[] {
  if (fuente === FUENTE_MONO || !texto.match(SIMBOLOS)) return texto;
  const propiedades: Record<string, unknown> = {};
  for (const clave of PROPIEDADES_EN_LINEA) if (nodo[clave] !== undefined) propiedades[clave] = nodo[clave];

  const partes: any[] = [];
  let ultimo = 0;
  for (const m of texto.matchAll(SIMBOLOS)) {
    const inicio = m.index ?? 0;
    if (inicio > ultimo) partes.push({ ...propiedades, text: texto.slice(ultimo, inicio) });
    partes.push({ ...propiedades, text: m[0], font: FUENTE_SIMBOLOS });
    ultimo = inicio + m[0].length;
  }
  if (ultimo < texto.length) partes.push({ ...propiedades, text: texto.slice(ultimo) });
  return partes;
}

// Marca el texto dentro del título envuelto, para que pageBreakBefore no lo cuente como "contenido siguiente"
const TEXTO_DE_TITULO = "texto-de-titulo";

// Tabla de una celda con solo el borde inferior: "*" línea a todo el ancho, "auto" del ancho del texto
function tituloConLinea(nodo: any, layout: string, ancho: string): any {
  const texto = { ...nodo, style: TEXTO_DE_TITULO };
  delete texto.margin;
  delete texto.headlineLevel;
  return {
    table: { widths: [ancho], body: [[texto]], dontBreakRows: true },
    layout,
    margin: nodo.margin,
    headlineLevel: nodo.headlineLevel,
  };
}

function envolverEnCaja(nodo: any, layout: string, noPartir: boolean): any {
  const contenido = { ...nodo };
  delete contenido.margin;
  return {
    table: { widths: ["*"], body: [[contenido]] },
    layout,
    margin: [0, 4, 0, 10],
    unbreakable: noPartir,
  };
}

function textoPlano(nodo: any): string {
  if (typeof nodo === "string") return nodo;
  if (Array.isArray(nodo)) return nodo.map(textoPlano).join("");
  if (!nodo || typeof nodo !== "object") return "";
  return [nodo.text, nodo.stack, nodo.ul, nodo.ol, nodo.table?.body].map(textoPlano).join("");
}
