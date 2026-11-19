/** A file's text, as Vite's `?raw` import gives it (the add-in's assets, assets.ts). */
declare module '*?raw' {
  const text: string
  export default text
}
