# EstudIO 📚✨

**EstudIO** es una aplicación de escritorio diseñada para virtualizar tu espacio de estudio. Con una interfaz moderna, te permite gestionar materias, redactar apuntes interactivos y hacer un seguimiento exhaustivo de tus recordatorios y tareas académicas, todo centralizado en un único entorno digital de alto rendimiento.

---

## 🚀 ¿Qué es EstudIO?

EstudIO unifica las herramientas esenciales del estudiante en una aplicación de escritorio multiplataforma ligera y ágil:
1. **Gestión de Materias**: Creación y organización de asignaturas (anuales o cuatrimestrales) con soporte de eliminación en cascada.
2. **Editor de Apuntes Avanzado**: Editor visual interactivo basado en **TipTap** que almacena tus notas en formato Markdown estándar (`.md`).
   - Herramientas de formato enriquecido, resaltado multicolor de texto (Amarillo, Verde, Azul, Rosa, Naranja), listas y citas.
   - Inserción y pegado directo de imágenes desde el portapapeles (capturas de pantalla) almacenadas automáticamente de forma local.
3. **Recordatorios y Calendario**: Agenda integrada para eventos (exámenes, entregas) con cálculo automático de alertas (desde 1 hora hasta 1 mes antes) y un panel sidebar de recordatorios para el día de hoy ("Hoy").
4. **Mini-Calendario Interactivo**: Visualizador mensual persistente en la barra lateral con marcadores de eventos.

---

## 💡 ¿Por qué es práctico usar EstudIO?

- **Todo en un Solo Lugar**: Evita la fragmentación de usar un editor de texto por separado, un calendario externo y carpetas del sistema. EstudIO integra todo en un escritorio unificado.
- **Privacidad y Velocidad Local**: Al estar desarrollado sobre **Tauri (Rust)** y **SQLite (`mi_DB.db3`)**, la aplicación es sumamente ligera, consume mínimos recursos y almacena toda tu información localmente sin depender de servidores en la nube.
- **Portabilidad de Apuntes (Markdown)**: Los apuntes se guardan como archivos `.md` reales en tu disco. Esto significa que no estás atrapado en un formato propietario; puedes abrirlos con Obsidian, VS Code o cualquier otro visor si decides cambiar.
- **Flujo de Trabajo Dinámico (Pega de Imágenes)**: Cuenta con integración nativa al portapapeles del sistema operativo mediante Tauri. Pega capturas de pantalla, diagramas y fotos de apuntes directamente (`Ctrl+V`) en el editor, y la app se encarga de guardarlos en una carpeta local `.recursos` asociada y enlazarlos de manera relativa.
- **Interfaz Responsiva e Inmersiva**: El diseño premium con efecto de vidrio esmerilado ofrece un ambiente estético agradable. Además, el editor cuenta con un modo de distracción reducida que permite colapsar/ocultar el menú lateral (sidebar) para maximizar el área de escritura tanto manualmente como de forma automática en pantallas medianas.

---

## 🛠️ Stack Tecnológico

- **Backend**: Rust + Tauri v2 (acceso a base de datos, sistema de archivos, diálogos del SO e integración con el portapapeles nativo).
- **Frontend**: HTML5, Vanilla CSS3 (diseño personalizado y variables de estilo) y TypeScript.
- **Base de Datos**: SQLite (`mi_DB.db3`) para el modelado relacional rápido y eficiente de materias, apuntes y eventos.
- **Editor**: TipTap (ProseMirror) extendido con soporte personalizado para inserción de imágenes, Markdown y extensiones de pegado de alta prioridad.
