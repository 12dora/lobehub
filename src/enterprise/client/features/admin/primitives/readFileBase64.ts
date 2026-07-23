/**
 * Read a File as base64 (without the data-URL prefix). Rejects with FILE_READ_FAILED on read error
 * or an unexpected result shape. Shared by the admin branding + tool-scope upload flows, which
 * previously each defined an identical copy.
 */
export const readFileBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('FILE_READ_FAILED'));
    reader.onload = () => {
      const value = String(reader.result ?? '');
      const comma = value.indexOf(',');
      if (comma < 0) return reject(new Error('FILE_READ_FAILED'));
      resolve(value.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
