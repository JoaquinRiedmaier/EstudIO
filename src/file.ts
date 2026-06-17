import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

/**
 * Abre un cuadro de diálogo para que el usuario seleccione una ruta (archivo o carpeta).
 * @param directory - Si es true, permite seleccionar una carpeta en lugar de un archivo.
 * @returns La ruta seleccionada o undefined si se canceló.
 */
export async function seleccionarRuta(directory: boolean = false): Promise<string | undefined> {
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
 * (Conservado para futuras implementaciones).
 */
export async function readFile(filePath: string): Promise<string | undefined> {
  try {
    const response: any = await invoke("read_file", { targetFile: filePath });
    return response.text_data;
  } catch (error) {
    console.error("Error al leer el archivo:", error);
    return undefined;
  }
}

/**
 * Guarda contenido en un archivo usando el backend de Tauri.
 * (Conservado para futuras implementaciones).
 */
export async function saveFile(savePath: string, data: string): Promise<boolean> {
  try {
    await invoke("save_file", { savePath: savePath, markdownTextData: data });
    return true;
  } catch (error) {
    console.error("Error al guardar el archivo:", error);
    return false;
  }
}
