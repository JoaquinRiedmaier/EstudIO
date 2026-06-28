import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

/**
 * Abre un cuadro de diálogo para que el usuario seleccione una ruta (archivo o carpeta).
 * @param directory - Si es true, permite seleccionar una carpeta en lugar de un archivo.
 * @returns La ruta seleccionada o undefined si se canceló.
 */
export async function seleccionarRuta(
  directory: boolean = false,
): Promise<string | undefined> {
  try {
    const selectedPath = await open({
      directory: directory,
      multiple: false,
    });
    return selectedPath ?? undefined;
  } catch (error) {
    console.error("Error al seleccionar la ruta:", error);
    return undefined;
  }
}

/**
 * Lee un archivo usando el backend de Tauri.
 */
export async function readFile(filePath: string): Promise<string | undefined> {
  try {
    const response = await invoke<string>("abrir_apunte", { path: filePath });
    return response;
  } catch (error) {
    console.error("Error al leer el archivo:", error);
    return undefined;
  }
}

export async function saveFile(
  savePath: string,
  data: string,
  apunteCodigo: string,
  fechaModif: string,
): Promise<boolean> {
  try {
    await invoke("guardar_apunte", {
      path: savePath,
      content: data,
      apunteCodigo,
      fechaModif,
    });
    return true;
  } catch (error) {
    console.error("Error al guardar el archivo:", error);
    return false;
  }
}
