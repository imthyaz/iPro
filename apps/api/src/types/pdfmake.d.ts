// pdfmake 0.3 ships no TypeScript types; this declares the part of its Node API iPro uses.
declare module 'pdfmake' {
  interface FontFiles {
    normal: string;
    bold: string;
    italics: string;
    bolditalics: string;
  }
  interface OutputDocument {
    getBuffer(): Promise<Buffer>;
  }
  interface PdfMake {
    addFonts(fonts: Record<string, FontFiles>): void;
    setLocalAccessPolicy(callback: (path: string) => boolean): void;
    setUrlAccessPolicy(callback: (url: string) => boolean): void;
    createPdf(definition: Record<string, unknown>): OutputDocument;
  }
  const pdfmake: PdfMake;
  export default pdfmake;
}
