import { invoke } from "@tauri-apps/api/core";
import { seleccionarRuta } from "./file";

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

// State
let materiasCache: Materia[] = [];
let currentCalendarDate = new Date();

// DOM Elements
document.addEventListener("DOMContentLoaded", () => {
  setupNavigation();
  setupForms();
  setupCalendar();
  setupModal();
  cargarUltimosModificados();
  // removed dateInput init
});

function setupNavigation() {
  const navBtns = document.querySelectorAll(".nav-btn");
  const views = document.querySelectorAll(".view");
  const titleEl = document.getElementById("view-title");

  navBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      // Update active button
      navBtns.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");

      // Update title
      if (titleEl) titleEl.textContent = btn.textContent?.trim() || "";

      // Show target view
      const targetId = btn.getAttribute("data-target");
      views.forEach(v => v.classList.remove("active"));
      document.getElementById(targetId || "")?.classList.add("active");

      // Specific view logic
      if (targetId === "view-materias") {
        cargarMaterias();
      } else if (targetId === "view-nuevo-apunte") {
        cargarSelectorMaterias();
      }
    });
  });
}

function setupForms() {
  const matAnual = document.getElementById("mat-anual") as HTMLInputElement;
  const matCuatrimestre = document.getElementById("mat-cuatrimestre") as HTMLInputElement;

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
    const nombre = (document.getElementById("mat-nombre") as HTMLInputElement).value;
    const ano = parseInt((document.getElementById("mat-ano") as HTMLInputElement).value);
    const anual = matAnual.checked;
    const cuatrimestre = anual ? 0 : parseInt(matCuatrimestre.value);

    try {
      const resp = await invoke<string>("crear_materia", { nombre, ano, cuatrimestre, anual });
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
    const tema = (document.getElementById("apu-tema") as HTMLInputElement).value;
    const materiaCodigo = (document.getElementById("apu-materia") as HTMLSelectElement).value;

    // Auto-generate current date for creation
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const fechaCreacion = `${year}-${month}-${day} ${hours}:${minutes}`;

    const ruta = (document.getElementById("apu-ruta") as HTMLInputElement).value;

    if (!materiaCodigo) {
      showToast("Por favor selecciona una materia", "error");
      return;
    }

    try {
      const resp = await invoke<string>("crear_apunte", {
        tema,
        materiaCodigo,
        fechaCreacion,
        ultModificacion: fechaCreacion,
        ruta
      });
      showToast(resp, "success");
      (formApunte as HTMLFormElement).reset();
      cargarUltimosModificados();
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

function setupModal() {
  const modal = document.getElementById("modal-apunte");
  const closeModalBtn = document.getElementById("close-modal");
  const formModalApunte = document.getElementById("form-modal-apunte");

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

  formModalApunte?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const tema = (document.getElementById("modal-apu-tema") as HTMLInputElement).value;
    const materiaCodigo = (document.getElementById("modal-apu-materia") as HTMLInputElement).value;

    // Auto-generate current date for creation
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const fechaCreacion = `${year}-${month}-${day} ${hours}:${minutes}`;

    const ruta = (document.getElementById("modal-apu-ruta") as HTMLInputElement).value;

    if (!materiaCodigo) {
      showToast("Error: Código de materia faltante", "error");
      return;
    }

    try {
      const resp = await invoke<string>("crear_apunte", {
        tema,
        materiaCodigo,
        fechaCreacion,
        ultModificacion: fechaCreacion,
        ruta
      });
      showToast(resp, "success");
      (formModalApunte as HTMLFormElement).reset();
      modal?.classList.remove("active");
      cargarUltimosModificados();
    } catch (err: any) {
      showToast(err.toString(), "error");
    }
  });

  const btnModalSelectRuta = document.getElementById("btn-modal-select-ruta");
  btnModalSelectRuta?.addEventListener("click", async () => {
    const ruta = await seleccionarRuta(true);
    if (ruta) {
      (document.getElementById("modal-apu-ruta") as HTMLInputElement).value = ruta;
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
      container.innerHTML = `<div style="text-align:center; padding: 3rem; color:var(--text-secondary); width: 100%; grid-column: 1/-1;">No hay materias registradas.</div>`;
      return;
    }

    container.innerHTML = "";
    materiasCache.forEach(mat => {
      const card = document.createElement("div");
      card.className = "materia-card glass-panel";

      const badgeAnual = mat.anual
        ? `<span class="badge anual">Anual</span>`
        : `<span class="badge cuatrimestral">Cuatrimestral</span>`;

      const cuatrimestreHtml = mat.anual 
        ? "" 
        : `<div style="font-size:0.85rem; color:var(--text-secondary)">Cuatrimestre: <strong style="color:white">${mat.cuatrimestre}</strong></div>`;

      card.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:start">
          <span class="badge" style="background:rgba(255,255,255,0.05)">#${mat.codigo}</span>
          ${badgeAnual}
        </div>
        <h4>${mat.nombre}</h4>
        <div style="display:flex; gap:1rem; margin-top: auto; padding-top: 1rem;">
          <div style="font-size:0.85rem; color:var(--text-secondary)">Año: <strong style="color:white">${mat.ano}</strong></div>
          ${cuatrimestreHtml}
        </div>
      `;

      const btnAddApunte = document.createElement("button");
      btnAddApunte.className = "btn-secondary";
      btnAddApunte.style.marginTop = "1rem";
      btnAddApunte.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
        Agregar Apunte
      `;

      btnAddApunte.onclick = () => {
        const modal = document.getElementById("modal-apunte");
        const modalMateriaId = document.getElementById("modal-apu-materia") as HTMLInputElement;
        const modalMateriaNombre = document.getElementById("modal-materia-nombre");
        if (modal && modalMateriaId && modalMateriaNombre) {
          modalMateriaId.value = mat.codigo.toString();
          modalMateriaNombre.textContent = `Materia: ${mat.nombre}`;
          modal.classList.add("active");
        }
      };

      card.appendChild(btnAddApunte);
      container.appendChild(card);
    });
  } catch (err: any) {
    container.innerHTML = `<p style="color:var(--error)">Error: ${err}</p>`;
    showToast(err.toString(), "error");
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

    materiasCache.forEach(mat => {
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

  const icon = type === "success"
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

function renderCalendar() {
  const monthYearStr = document.getElementById("calendar-month-year");
  const datesGrid = document.getElementById("calendar-dates");

  if (!monthYearStr || !datesGrid) return;

  const year = currentCalendarDate.getFullYear();
  const month = currentCalendarDate.getMonth();

  const monthNames = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
  monthYearStr.textContent = `${monthNames[month]} ${year}`;

  datesGrid.innerHTML = "";

  const firstDay = new Date(year, month, 1).getDay(); // 0 is Sunday
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const prevMonthDays = new Date(year, month, 0).getDate();

  const today = new Date();

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

    if (year === today.getFullYear() && month === today.getMonth() && i === today.getDate()) {
      dateEl.classList.add("today");
    }

    dateEl.textContent = i.toString();
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
    apuntes.forEach(apunte => {
      const li = document.createElement("li");
      li.className = "recent-note-item";
      
      const [datePart, timePart] = apunte.ult_modificacion.split(' ');
      let formattedDate = apunte.ult_modificacion;
      
      if (datePart && timePart) {
        const dateParts = datePart.split('-');
        if (dateParts.length === 3) {
          formattedDate = `${dateParts[2]}/${dateParts[1]}/${dateParts[0]} ${timePart}`;
        }
      } else {
        // Fallback for older entries without time
        const dateParts = apunte.ult_modificacion.split('-');
        if (dateParts.length === 3) {
          formattedDate = `${dateParts[2]}/${dateParts[1]}/${dateParts[0]}`;
        }
      }

      li.innerHTML = `
        <span class="recent-note-tema" title="${apunte.tema}">${apunte.tema}</span>
        <span class="recent-note-fecha">${formattedDate}</span>
      `;
      container.appendChild(li);
    });
  } catch (err) {
    console.error("Error cargando apuntes recientes", err);
    container.innerHTML = `<li style="font-size: 0.8rem; color: var(--error);">Error al cargar.</li>`;
  }
}
