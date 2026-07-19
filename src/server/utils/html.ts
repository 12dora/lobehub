/** Escapes text before interpolation into server-rendered HTML markup. */
export const escapeHtml = (value: string): string =>
  value.replaceAll(/[&<>'"]/g, (character) => {
    switch (character) {
      case '&': {
        return '&amp;';
      }
      case '<': {
        return '&lt;';
      }
      case '>': {
        return '&gt;';
      }
      case "'": {
        return '&#39;';
      }
      case '"': {
        return '&quot;';
      }
      default: {
        return character;
      }
    }
  });
