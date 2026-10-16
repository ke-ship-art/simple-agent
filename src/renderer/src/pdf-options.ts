export const pdfOptions = {
  isEvalSupported: false,
  enableXfa: false,
  cMapUrl: new URL('/pdfjs/cmaps/', location.href).href,
  cMapPacked: true,
  standardFontDataUrl: new URL('/pdfjs/standard_fonts/', location.href).href,
  wasmUrl: new URL('/pdfjs/wasm/', location.href).href,
  useSystemFonts: true
};
